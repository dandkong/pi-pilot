import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { renderTelegramHtml } from "../render/telegram-html.ts";
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
  TelegramCommand,
} from "./types.ts";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const log = logger.child("telegram");

export class TelegramAdapter implements ChatAdapter {
  private readonly bot: Bot;
  private readonly messageHandlers: Array<(message: ChatMessage) => Promise<void>> = [];
  private readonly callbackHandlers: Array<(callback: ChatCallback) => Promise<void>> = [];
  private started = false;

  private readonly tmpDir: string;

  constructor(
    token: string,
    private readonly commands: TelegramCommand[] = [],
  ) {
    this.bot = new Bot(token);
    this.tmpDir = join(process.cwd(), ".tmp");
    mkdirSync(this.tmpDir, { recursive: true });
    this.bot.on("message:text", async (ctx) => this.handleTextMessage(ctx));
    this.bot.on("message:photo", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:document", async (ctx) => this.handleFileMessage(ctx));
    this.bot.on("message:video", async (ctx) => this.handleFileMessage(ctx));
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
    await this.bot.stop();
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<SentMessage[]> {
    const content = prepareTelegramMessage(text || "(no response)", options?.render);
    const chunks = splitTelegramMessage(content.text);
    const sent: SentMessage[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const messageOptions = {
        parse_mode: content.parseMode,
        link_preview_options: { is_disabled: true },
        reply_parameters:
          index === 0 && options?.replyToMessageId
            ? { message_id: Number(options.replyToMessageId) }
            : undefined,
        reply_markup: index === chunks.length - 1 ? toInlineKeyboard(options?.buttons) : undefined,
      };
      const message = await this.bot.api.sendMessage(chatId, chunk, messageOptions).catch((error) => {
        if (!content.fallbackText) throw error;
        log.warn("formatted send failed, retrying as plain text", formatGrammyError(error));
        return this.bot.api.sendMessage(chatId, content.fallbackText, {
          ...messageOptions,
          parse_mode: undefined,
        });
      });
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

  async startTextStream(chatId: string, options?: SendMessageOptions): Promise<ChatTextStream | undefined> {
    const [message] = await this.sendMessage(chatId, "...", { ...options, render: "plain" });
    if (!message) return undefined;

    return {
      update: async (text) => {
        if (!text.trim()) return;
        await this.editStreamMessage(chatId, message.messageId, limitTelegramText(text));
      },
      finish: async (text) => {
        const finalText = text.trim() || "(no response)";
        if (finalText.length > TELEGRAM_MESSAGE_LIMIT) {
          const chunks = splitTelegramMessage(finalText);
          await this.editStreamMessage(chatId, message.messageId, chunks[0] ?? "(no response)");
          for (const chunk of chunks.slice(1)) {
            await this.sendMessage(chatId, chunk);
          }
          return;
        }

        const content = prepareTelegramMessage(finalText, options?.render);
        await this.editStreamMessage(chatId, message.messageId, limitTelegramText(content.text), content.parseMode).catch((error) => {
          if (!content.fallbackText) throw error;
          log.warn("formatted stream finish failed, retrying as plain text", formatGrammyError(error));
          return this.editStreamMessage(chatId, message.messageId, limitTelegramText(content.fallbackText), undefined);
        });
      },
    };
  }

  private async editStreamMessage(chatId: string, messageId: string, text: string, parseMode?: "HTML"): Promise<void> {
    await this.bot.api.editMessageText(chatId, Number(messageId), text, {
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    }).catch((error) => {
      if (isMessageNotModified(error)) return;
      throw error;
    });
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
      text: text || "(user sent file(s))",
      attachments,
    };

    this.dispatchMessage(chatMessage);
  }

  private async downloadFile(fileId: string, fileName: string, mimeType?: string, fileSize?: number): Promise<ChatAttachment | undefined> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return undefined;

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const data = await fetch(url).then((r) => r.arrayBuffer());
    const localPath = join(this.tmpDir, fileName);
    writeFileSync(localPath, Buffer.from(data));

    return { file: `.tmp/${fileName}`, mimeType, fileSize };
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

function prepareTelegramMessage(
  text: string,
  render: SendMessageOptions["render"] = "plain",
): { text: string; parseMode?: "HTML"; fallbackText?: string } {
  if (render !== "markdown") return { text };

  const html = renderTelegramHtml(text);
  if (html.length > 3_900) return { text };
  return { text: html, parseMode: "HTML", fallbackText: text };
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

function limitTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 20)}\n...(truncated)`;
}

function splitTelegramMessage(text: string) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks.length ? chunks : [""];
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
