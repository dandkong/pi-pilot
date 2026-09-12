import remend from "remend";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { chunkText } from "../render/chunking.ts";
import type {
  ChatAttachment,
  ChatAdapter,
  ChatCallback,
  ChatMessage,
  ChatTextStream,
  EditMessageOptions,
  InlineButton,
  SendMessageOptions,
  SentMessage,
  ChatCommand,
} from "./types.ts";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_RICH_MARKDOWN_CHUNK_LIMIT = 30_000;
const MEDIA_GROUP_FLUSH_MS = 1_000;
// Streaming rewrites a persisted message, which Telegram rate limits far more
// tightly than it limits a fresh send, so the cadence stays deliberately
// conservative.
const STREAM_INTERVAL_MS = 800;
const log = logger.child("telegram");

type MediaGroupState = {
  messages: ChatMessage[];
  timer: Timer;
};

export class TelegramAdapter implements ChatAdapter {
  private readonly bot: Bot;
  private readonly messageHandlers: Array<(message: ChatMessage) => Promise<void>> = [];
  private readonly callbackHandlers: Array<(callback: ChatCallback) => Promise<void>> = [];
  private readonly mediaGroups = new Map<string, MediaGroupState>();
  private started = false;

  private readonly tmpDir: string;

  constructor(token: string, private readonly commands: ChatCommand[] = []) {
    this.bot = new Bot(token);
    this.tmpDir = join(tmpdir(), "pi-pilot");
    mkdirSync(this.tmpDir, { recursive: true });
    this.bot.on("message:text", async (ctx) => this.handleTextMessage(ctx));
    this.bot.on("message:photo", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:document", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:video", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:audio", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:voice", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("callback_query:data", async (ctx) => this.handleCallback(ctx));
    this.bot.catch((error) => {
      log.error("bot error", formatGrammyError(error.error));
    });
  }

  onMessage(handler: (message: ChatMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: (callback: ChatCallback) => Promise<void>): void {
    this.callbackHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.commands.length) {
      await this.bot.api.setMyCommands(this.commands);
    }
    await this.bot.start({ allowed_updates: ["message", "callback_query"] });
    log.info(`bot started, tmpDir=${this.tmpDir}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const state of this.mediaGroups.values()) clearTimeout(state.timer);
    this.mediaGroups.clear();
    await this.bot.stop();
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<SentMessage[]> {
    const messageText = text || "(no response)";
    if (options?.render === "markdown") {
      return this.sendRichMarkdownMessages(chatId, messageText, options);
    }
    return this.sendPlainMessages(chatId, messageText, options);
  }

  private async sendRichMarkdownMessages(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SentMessage[]> {
    const chunks = chunkText(text, TELEGRAM_RICH_MARKDOWN_CHUNK_LIMIT);
    const sent: SentMessage[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const messageOptions = {
        reply_parameters:
          index === 0 && options?.replyToMessageId
            ? { message_id: Number(options.replyToMessageId) }
            : undefined,
        reply_markup: index === chunks.length - 1 ? toInlineKeyboard(options?.buttons) : undefined,
      };

      try {
        const message = await this.bot.api.sendRichMessage(chatId, { markdown: chunk }, messageOptions);
        sent.push({ messageId: String(message.message_id) });
      } catch (error) {
        log.warn("rich markdown send failed, retrying as plain text", formatGrammyError(error));
        const fallback = await this.sendPlainMessages(chatId, chunk, {
          ...options,
          replyToMessageId: index === 0 ? options?.replyToMessageId : undefined,
          buttons: index === chunks.length - 1 ? options?.buttons : undefined,
        });
        sent.push(...fallback);
      }
    }

    return sent;
  }

  private async sendPlainMessages(chatId: string, text: string, options?: SendMessageOptions): Promise<SentMessage[]> {
    const chunks = chunkText(text, TELEGRAM_MESSAGE_LIMIT);
    const sent: SentMessage[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const messageOptions = {
        link_preview_options: { is_disabled: true },
        reply_parameters:
          index === 0 && options?.replyToMessageId
            ? { message_id: Number(options.replyToMessageId) }
            : undefined,
        reply_markup: index === chunks.length - 1 ? toInlineKeyboard(options?.buttons) : undefined,
      };
      const message = await this.bot.api.sendMessage(chatId, chunk, messageOptions);
      sent.push({ messageId: String(message.message_id) });
    }
    return sent;
  }

  async editMessage(chatId: string, messageId: string, text: string, options?: EditMessageOptions): Promise<void> {
    await this.bot.api.editMessageText(chatId, Number(messageId), text, {
      link_preview_options: { is_disabled: true },
      reply_markup: toInlineKeyboard(options?.buttons),
    });
  }

  getStreamUpdateIntervalMs(): number {
    return STREAM_INTERVAL_MS;
  }

  async startTextStream(chatId: string, options?: SendMessageOptions): Promise<ChatTextStream | undefined> {
    // Rich messages carry the markdown rendering and allow a much larger body.
    // Plain text is the fallback once rich messages turn out to be rejected.
    let richEnabled = options?.render === "markdown";
    const chunkLimit = richEnabled ? TELEGRAM_RICH_MARKDOWN_CHUNK_LIMIT : TELEGRAM_MESSAGE_LIMIT;
    const messages: Array<{ messageId: string; raw: string }> = [];

    const sync = async (text: string, finished = false) => {
      const body = text.trim() || (finished ? "(no response)" : "");
      if (!body) return;

      const chunks = chunkText(body, chunkLimit);
      if (!chunks.length || !chunks[0]?.trim()) return;

      for (const [index, chunk] of chunks.entries()) {
        const existing = messages[index];
        if (!existing) {
          const sent = await this.sendStreamMessage(
            chatId,
            chunk,
            index === 0 ? options : undefined,
            richEnabled,
          );
          if (!sent) continue;
          if (sent.richFailed) richEnabled = false;
          messages.push({ messageId: sent.messageId, raw: chunk });
          continue;
        }

        if (existing.raw === chunk) continue;

        const edited = await this.editStreamMessage(chatId, existing.messageId, chunk, richEnabled);
        if (edited.richFailed) richEnabled = false;
        if (edited.ok) existing.raw = chunk;
      }
    };

    return {
      update: async (text) => {
        if (!text.trim()) return;
        await sync(text);
      },
      finish: async (text) => {
        await sync(text, true);
      },
    };
  }

  private async sendStreamMessage(
    chatId: string,
    raw: string,
    options: SendMessageOptions | undefined,
    rich: boolean,
  ): Promise<{ messageId: string; richFailed: boolean } | undefined> {
    const replyParameters = options?.replyToMessageId
      ? { message_id: Number(options.replyToMessageId) }
      : undefined;

    if (rich) {
      try {
        const message = await this.bot.api.sendRichMessage(
          chatId,
          { markdown: prepareStreamingMarkdown(raw) },
          { reply_parameters: replyParameters },
        );
        return { messageId: String(message.message_id), richFailed: false };
      } catch (error) {
        log.warn("rich stream send failed, falling back to plain text", formatGrammyError(error));
      }
    }

    const message = await this.bot.api.sendMessage(chatId, raw, {
      link_preview_options: { is_disabled: true },
      reply_parameters: replyParameters,
      reply_markup: toInlineKeyboard(options?.buttons),
    });
    return { messageId: String(message.message_id), richFailed: rich };
  }

  private async editStreamMessage(
    chatId: string,
    messageId: string,
    raw: string,
    rich: boolean,
  ): Promise<{ ok: boolean; richFailed: boolean }> {
    const numericId = Number(messageId);

    if (rich) {
      try {
        await this.bot.api.editMessageText(chatId, numericId, { markdown: prepareStreamingMarkdown(raw) });
        return { ok: true, richFailed: false };
      } catch (error) {
        if (isMessageNotModified(error)) return { ok: true, richFailed: false };
        log.warn("rich stream edit failed, falling back to plain text", formatGrammyError(error));
      }
    }

    try {
      await this.bot.api.editMessageText(chatId, numericId, raw, {
        link_preview_options: { is_disabled: true },
      });
      return { ok: true, richFailed: rich };
    } catch (error) {
      if (isMessageNotModified(error)) return { ok: true, richFailed: rich };
      log.warn("stream edit failed", formatGrammyError(error));
      return { ok: false, richFailed: rich };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, "typing");
  }

  async answerCallback(callback: ChatCallback, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callback.callbackId, { text });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    const text = message?.text?.trim();
    if (!message || !text || message.from?.is_bot) return;

    const chatMessage: ChatMessage = {
      platform: "telegram",
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      userId: String(message.from?.id ?? message.chat.id),
      username: message.from?.username ?? message.from?.first_name,
      text,
    };

    this.dispatchMessage(chatMessage);
  }

  private async handleFileMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || message.from?.is_bot) return;

    const text = message.caption?.trim() ?? "";
    const attachments: ChatAttachment[] = [];

    // Handle photo
    if (message.photo) {
      const photo = message.photo.at(-1); // highest resolution
      if (photo) {
        const attachment = await this.downloadFile(photo.file_id, `photo_${Date.now()}.jpg`, "image/jpeg", photo.file_size);
        if (attachment) attachments.push(attachment);
      }
    }

    // Handle document
    if (message.document) {
      const doc = message.document;
      const rawName = doc.file_name ?? `file_${Date.now()}`;
      const attachment = await this.downloadFile(doc.file_id, `${Date.now()}_${rawName}`, doc.mime_type, doc.file_size);
      if (attachment) attachments.push(attachment);
    }

    // Handle video
    if (message.video) {
      const video = message.video;
      const rawName = video.file_name ?? `video_${Date.now()}.mp4`;
      const attachment = await this.downloadFile(video.file_id, `${Date.now()}_${rawName}`, video.mime_type, video.file_size);
      if (attachment) attachments.push(attachment);
    }

    // Handle audio
    if (message.audio) {
      const audio = message.audio;
      const rawName = audio.file_name ?? `audio_${Date.now()}.mp3`;
      const attachment = await this.downloadFile(audio.file_id, `${Date.now()}_${rawName}`, audio.mime_type, audio.file_size);
      if (attachment) attachments.push(attachment);
    }

    // Handle voice
    if (message.voice) {
      const voice = message.voice;
      const attachment = await this.downloadFile(voice.file_id, `voice_${Date.now()}.ogg`, voice.mime_type, voice.file_size);
      if (attachment) attachments.push(attachment);
    }

    if (!attachments.length) return;

    const chatMessage: ChatMessage = {
      platform: "telegram",
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      userId: String(message.from?.id ?? message.chat.id),
      username: message.from?.username ?? message.from?.first_name,
      text,
      attachments,
    };

    if (message.media_group_id) {
      this.enqueueMediaGroup(message.chat.id, message.media_group_id, chatMessage);
      return;
    }

    this.dispatchMessage({
      ...chatMessage,
      text: chatMessage.text || "(user sent file(s))",
    });
  }

  private enqueueMediaGroup(chatId: string | number, mediaGroupId: string, message: ChatMessage): void {
    const key = `${chatId}:${mediaGroupId}`;
    const existing = this.mediaGroups.get(key);
    if (existing) clearTimeout(existing.timer);

    const state: MediaGroupState = existing ?? {
      messages: [],
      timer: setTimeout(() => undefined, 0),
    };
    state.messages.push(message);
    state.timer = setTimeout(() => this.flushMediaGroup(key), MEDIA_GROUP_FLUSH_MS);
    this.mediaGroups.set(key, state);
  }

  private flushMediaGroup(key: string): void {
    const state = this.mediaGroups.get(key);
    if (!state) return;
    this.mediaGroups.delete(key);

    const messages = [...state.messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
    const first = messages[0];
    if (!first) return;

    const text = messages
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const attachments = messages.flatMap((message) => message.attachments ?? []);
    if (!attachments.length) return;

    this.dispatchMessage({
      ...first,
      text: text || "(user sent file(s))",
      attachments,
    });
  }

  private async downloadFile(fileId: string, fileName: string, mimeType?: string, fileSize?: number): Promise<ChatAttachment | undefined> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return undefined;

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const data = await fetch(url).then((r) => r.arrayBuffer());
    const localPath = join(this.tmpDir, fileName);
    writeFileSync(localPath, Buffer.from(data));

    return { file: localPath, mimeType, fileSize };
  }

  private async handleCallback(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    const data = query?.data;
    const message = query?.message;
    if (!query || !data || !message) return;

    const callback: ChatCallback = {
      platform: "telegram",
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      userId: String(query.from.id),
      callbackId: query.id,
      data,
    };

    this.dispatchCallback(callback);
  }

  private dispatchMessage(message: ChatMessage): void {
    for (const handler of this.messageHandlers) {
      void handler(message).catch((error) => {
        log.error("message handler failed", formatGrammyError(error));
      });
    }
  }

  private dispatchCallback(callback: ChatCallback): void {
    for (const handler of this.callbackHandlers) {
      void handler(callback).catch((error) => {
        log.error("callback handler failed", formatGrammyError(error));
      });
    }
  }
}

function prepareStreamingMarkdown(text: string): string {
  return remend(text, {
    // Telegram Rich Markdown doesn't support the streamdown: placeholder protocol.
    linkMode: "text-only",
    // Keep single-dollar currency/model output from being treated as math while streaming.
    inlineKatex: false,
  });
}

function toInlineKeyboard(buttons: InlineButton[][] | undefined): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;

  const keyboard = new InlineKeyboard();
  for (const row of buttons) {
    for (const button of row) {
      keyboard.text(button.text, button.callbackData);
    }
    keyboard.row();
  }
  return keyboard;
}

function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes("message is not modified");
}

function formatGrammyError(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.description} (${error.error_code})`;
  }
  if (error instanceof HttpError) {
    return `HTTP error: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
