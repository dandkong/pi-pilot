import type { RuntimeConfig } from "../config/runtime.ts";
import type {
  ChatAttachment,
  ChatAdapter,
  ChatCallback,
  ChatMessage,
} from "../adapters/types.ts";
import { logger } from "../logger.ts";
import { PiRunner, type CompactionEvent, type ToolEvent } from "../pi/runner.ts";
import { ChatCommands } from "./chat-commands.ts";

const log = logger.child("runtime");

export type ChatState = {
  runner: PiRunner;
  busy: boolean;
  queue: ChatMessage[];
};

export type ChatStateGetter = () => Promise<ChatState>;

export type ChatRuntimeOptions = {
  onExitRequest?: () => Promise<void> | void;
};

export class ChatRuntime {
  private state: ChatState | undefined;
  private initPromise: Promise<void> | undefined;
  private activeChatId: string | undefined;
  private readonly commands: ChatCommands;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly adapter: ChatAdapter,
    options: ChatRuntimeOptions = {},
  ) {
    this.commands = new ChatCommands(
      adapter,
      () => this.getState(),
      options.onExitRequest,
    );
  }

  async handleMessage(message: ChatMessage): Promise<void> {
    this.activeChatId = message.chatId;

    if (!this.isAllowedUser(message.userId)) {
      log.warn(`[chat ${message.chatId}] rejected unauthorized user`, {
        userId: message.userId,
        username: message.username,
      });
      await this.adapter.sendMessage(
        message.chatId,
        `Unauthorized user: ${message.userId}`,
        { replyToMessageId: message.messageId },
      );
      return;
    }

    if (await this.commands.handleMessage(message)) return;

    const prompt = formatPrompt(message.text.trim(), message.attachments);
    if (!prompt) return;

    const state = await this.getState();
    state.queue.push(message);

    if (state.busy) {
      log.info(`[chat ${message.chatId}] queued message`, {
        messageId: message.messageId,
        queueLength: state.queue.length,
      });
      await this.adapter.sendMessage(message.chatId, "Queued.", {
        replyToMessageId: message.messageId,
      });
      return;
    }

    await this.processQueue(state);
  }

  async handleCallback(callback: ChatCallback): Promise<void> {
    this.activeChatId = callback.chatId;

    if (!this.isAllowedUser(callback.userId)) {
      log.warn(`[chat ${callback.chatId}] rejected unauthorized callback`, {
        userId: callback.userId,
      });
      await this.adapter.answerCallback(callback, "Unauthorized user");
      return;
    }

    await this.commands.handleCallback(callback);
  }

  async warmup(): Promise<void> {
    if (this.state) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initializeState();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  dispose(): void {
    if (!this.state) return;
    this.state.queue.length = 0;
    this.state.runner.dispose();
    this.state = undefined;
    this.activeChatId = undefined;
  }

  private isAllowedUser(userId: string): boolean {
    const allowed = this.config.allowedTelegramUsers;
    return allowed.length === 0 || allowed.includes(userId);
  }

  private async getState(): Promise<ChatState> {
    await this.warmup();
    return this.requireState();
  }

  private requireState(): ChatState {
    if (!this.state) {
      throw new Error("Chat runtime is not initialized");
    }
    return this.state;
  }

  private async initializeState(): Promise<void> {
    const runner = new PiRunner(this.config);
    const state = { runner, busy: false, queue: [] };
    await runner.init();

    runner.setCompactionCallback((event) => {
      const chatId = this.activeChatId;
      if (!chatId) return;
      this.handleCompactionEvent(chatId, event).catch((error) => {
        log.error(`[chat ${chatId}] compaction notification failed`, error);
      });
    });

    this.state = state;
  }

  private async handleCompactionEvent(chatId: string, event: CompactionEvent): Promise<void> {
    if (event.type === "compaction_start") {
      const reason = event.reason === "manual" ? "manual" : event.reason === "threshold" ? "threshold reached" : "context overflow";
      await this.adapter.sendMessage(chatId, `🔄 Compacting context (${reason})...`);
      return;
    }

    if (event.type === "compaction_end") {
      if (event.aborted) {
        await this.adapter.sendMessage(chatId, "⚠️ Compaction aborted.");
        return;
      }
      if (event.errorMessage) {
        await this.adapter.sendMessage(chatId, `❌ Compaction failed: ${event.errorMessage}`);
        return;
      }
      await this.adapter.sendMessage(chatId, "✅ Context compacted.");
    }
  }

  private async processQueue(state: ChatState): Promise<void> {
    if (state.busy) return;
    state.busy = true;

    try {
      while (state.queue.length) {
        const next = state.queue.shift();
        if (!next) continue;
        await this.runQueuedMessage(next, state);
      }
    } finally {
      state.busy = false;
    }
  }

  private async runQueuedMessage(message: ChatMessage, state: ChatState): Promise<void> {
    this.activeChatId = message.chatId;
    const runtimeStatus = await state.runner.getRuntimeStatus();
    if (runtimeStatus.isCompacting) {
      await this.adapter.sendMessage(
        message.chatId,
        "Compaction is running. Try again after it finishes.",
        { replyToMessageId: message.messageId },
      );
      return;
    }

    const typingInterval = setInterval(() => {
      this.adapter
        .sendTyping(message.chatId)
        .catch((error) =>
          log.warn(`[chat ${message.chatId}] typing failed`, error),
        );
    }, 4_000);

    try {
      await this.adapter.sendTyping(message.chatId);
      const response = createTurnStreamSender(this.adapter, message);
      const startedAt = Date.now();
      const prompt = formatPrompt(message.text.trim(), message.attachments);
      const answer = await state.runner.run(prompt, {
        onTextDelta: (delta) => response.pushText(delta),
        onToolStart: (event) => response.pushToolStart(event),
      });
      await response.finish(answer || "(no response)");
      log.info(`[chat ${message.chatId}] turn completed`, {
        durationMs: Date.now() - startedAt,
        outputLength: answer.length,
        queueLength: state.queue.length,
      });
    } catch (error) {
      log.error(`[chat ${message.chatId}] pi failed`, error);
      await this.adapter.sendMessage(
        message.chatId,
        `Pi failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
    } finally {
      clearInterval(typingInterval);
    }
  }
}

function createTurnStreamSender(adapter: ChatAdapter, message: ChatMessage) {
  let text = "";
  let stream: Awaited<ReturnType<ChatAdapter["startTextStream"]>>;
  let streamStarted = false;
  let pending = Promise.resolve();
  let scheduled: Timer | undefined;
  const minUpdateIntervalMs = 800;
  let lastUpdatedAt = 0;

  const startStream = async () => {
    if (streamStarted) return stream;
    streamStarted = true;
    stream = await adapter.startTextStream(message.chatId, { render: "markdown" });
    return stream;
  };

  const queue = (task: () => Promise<void>) => {
    pending = pending.then(task).catch((error) => {
      log.warn(`[chat ${message.chatId}] response stream failed`, error);
    });
    return pending;
  };

  const update = () => queue(async () => {
    const current = text;
    if (!current.trim()) return;
    const activeStream = await startStream();
    if (!activeStream) return;
    await activeStream.update(current);
    lastUpdatedAt = Date.now();
  });

  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      const now = Date.now();
      if (now - lastUpdatedAt < minUpdateIntervalMs) {
        scheduleUpdate();
        return;
      }
      update();
    }, 250);
  };

  return {
    pushText(delta: string) {
      text += delta;
      scheduleUpdate();
    },
    pushToolStart(event: ToolEvent) {
      const separator = text.trim() ? "\n" : "";
      text = `${text.trimEnd()}${separator}${formatToolStart(event)}\n`;
      update();
    },
    async finish(fallbackText: string) {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = undefined;
      }
      await pending;
      const finalText = text.trim() || fallbackText;
      const activeStream = await startStream();
      if (activeStream) {
        await activeStream.finish(finalText);
        return;
      }
      await adapter.sendMessage(message.chatId, finalText, { render: "markdown" });
    },
  };
}

function formatPrompt(text: string, attachments?: ChatAttachment[]): string {
  if (!attachments?.length) return text;
  const fileList = attachments.map((a) => a.file).join("\n");
  const prefix = `<attached>\n${fileList}\n</attached>`;
  return text ? `${prefix}\n${text}` : prefix;
}

const TOOL_ARG_LIMIT = 3;
const TOOL_SUMMARY_LIMIT = 140;
const TOOL_VALUE_LIMIT = 60;

function formatToolStart(event: ToolEvent): string {
  const name = String(event.toolName ?? "tool");
  const icon = toolIcon(name);
  const summary = summarizeToolArgs(name, event.args);
  return summary ? `${icon} ${name}: ${summary}` : `${icon} ${name}`;
}

function toolIcon(toolName: string): string {
  if (toolName === "read") return "📖";
  if (toolName === "bash") return "💻";
  if (toolName === "edit") return "📝";
  if (toolName === "write") return "📄";
  return "🛠️";
}

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;

  if (toolName === "read") return truncate(pickString(record, "path"));
  if (toolName === "bash") return truncate(pickString(record, "command"));
  if (toolName === "write") return truncate(pickString(record, "path"));
  if (toolName === "edit") {
    const path = pickString(record, "path");
    if (!path) return undefined;
    const editCount = Array.isArray(record.edits) ? record.edits.length : undefined;
    const suffix = editCount === undefined ? "" : ` (${editCount} edit${editCount === 1 ? "" : "s"})`;
    return truncate(`${path}${suffix}`);
  }

  return summarizeGenericArgs(record);
}

function summarizeGenericArgs(record: Record<string, unknown>): string | undefined {
  const entries = Object.entries(record);
  if (entries.length === 0) return undefined;

  const parts = entries.slice(0, TOOL_ARG_LIMIT).map(([key, value]) => `${key}=${formatGenericValue(value)}`);
  if (entries.length > TOOL_ARG_LIMIT) parts.push(`+${entries.length - TOOL_ARG_LIMIT} more`);

  return truncate(parts.join(", "), TOOL_SUMMARY_LIMIT);
}

function formatGenericValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(truncate(value, TOOL_VALUE_LIMIT) ?? "");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const preview = value.slice(0, 3).map((item) => formatGenericValue(item)).join(", ");
    return `[${preview}${value.length > 3 ? ", ..." : ""}]`;
  }
  if (typeof value === "object" && value) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}` : "{}";
  }
  return String(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string | undefined, limit = TOOL_SUMMARY_LIMIT): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

