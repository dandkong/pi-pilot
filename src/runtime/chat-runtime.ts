import type { RuntimeConfig } from "../config/runtime.ts";
import type {
  ChatAttachment,
  ChatAdapter,
  ChatCallback,
  ChatMessage,
} from "../adapters/types.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.ts";
import { PiRunner, type ToolEvent } from "../pi/runner.ts";
import { ChatCommands } from "./chat-commands.ts";

const log = logger.child("runtime");

export type ChatState = {
  runner: PiRunner;
  processingQueue: boolean;
  queue: ChatMessage[];
};

export type ChatStateGetter = () => Promise<ChatState>;

type ChatTarget = {
  chatId: string;
  replyToMessageId?: string;
};

export type ChatRuntimeOptions = {
  onExitRequest?: () => Promise<void> | void;
};

export class ChatRuntime {
  private state: ChatState | undefined;
  private initPromise: Promise<void> | undefined;
  private currentOutput: ReturnType<typeof createTurnStreamSender> | undefined;
  private outputQueue = Promise.resolve();
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

    const routedMessage = this.routeMessage(message);

    if (await this.commands.handleMessage(routedMessage)) return;

    const prompt = formatPrompt(message.text.trim(), message.attachments);
    if (!prompt) return;

    const state = await this.getState();
    state.queue.push(routedMessage);

    if (await this.isBusy(state)) {
      await this.adapter.sendMessage(routedMessage.chatId, "Queued.", {
        replyToMessageId: routedMessage.messageId || undefined,
      });
      return;
    }

    await this.processQueue(state);
  }

  async handleCallback(callback: ChatCallback): Promise<void> {
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
    this.currentOutput = undefined;
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedActorIds.includes(userId);
  }

  private defaultNotificationTarget(): ChatTarget | undefined {
    const chatId = this.config.defaultTargetId ?? this.config.allowedActorIds[0];
    return chatId ? { chatId } : undefined;
  }

  private routeMessage(message: ChatMessage): ChatMessage {
    const target = this.defaultNotificationTarget();
    if (!target) return message;

    return {
      ...message,
      chatId: target.chatId,
      messageId: target.chatId === message.chatId ? message.messageId : "",
    };
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
    const state = { runner, processingQueue: false, queue: [] };

    runner.setOutputCallback((event) => {
      this.outputQueue = this.outputQueue
        .then(() => this.handleRunnerOutput(event))
        .catch((error) => log.error("runner output handling failed", error));
    });

    await runner.init();
    this.state = state;
  }

  private async handleRunnerOutput(event: AgentSessionEvent): Promise<void> {
    if (event.type === "compaction_start") {
      await this.sendCompactionStart(event.reason);
      return;
    }

    if (event.type === "compaction_end") {
      await this.sendCompactionEnd(event);
      if (!event.willRetry) await this.processQueueIfIdle();
      return;
    }

    if (event.type === "agent_start") {
      this.currentOutput = undefined;
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.getOrCreateOutput()?.pushText(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.getOrCreateOutput()?.pushToolStart(event);
      return;
    }

    if (event.type === "agent_end") {
      const output = this.currentOutput ?? this.getOrCreateOutput();
      this.currentOutput = undefined;
      await output?.finish(extractLastAssistantText(event.messages) || "(no response)");
      await this.processQueueIfIdle();
    }
  }

  private getOrCreateOutput(): ReturnType<typeof createTurnStreamSender> | undefined {
    if (this.currentOutput) return this.currentOutput;

    const target = this.defaultNotificationTarget();
    if (!target) {
      log.warn("dropping runner output: no target chat configured");
      return undefined;
    }

    this.currentOutput = createTurnStreamSender(this.adapter, target);
    return this.currentOutput;
  }

  private async sendCompactionStart(reason: "manual" | "threshold" | "overflow"): Promise<void> {
    const target = this.defaultNotificationTarget();
    if (!target) {
      log.warn("dropping compaction notification: no target chat configured");
      return;
    }

    const label = reason === "manual" ? "manual" : reason === "threshold" ? "threshold reached" : "context overflow";
    await this.adapter.sendMessage(target.chatId, `🔄 Compacting context (${label})...`);
  }

  private async sendCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): Promise<void> {
    const target = this.defaultNotificationTarget();
    if (!target) {
      log.warn("dropping compaction notification: no target chat configured");
      return;
    }

    if (event.aborted) {
      await this.adapter.sendMessage(target.chatId, "⚠️ Compaction aborted.");
      return;
    }
    if (event.errorMessage) {
      await this.adapter.sendMessage(target.chatId, `❌ Compaction failed: ${event.errorMessage}`);
      return;
    }
    await this.adapter.sendMessage(target.chatId, "✅ Context compacted.");
  }

  private async isBusy(state: ChatState): Promise<boolean> {
    return state.processingQueue || await this.isRunnerBusy(state);
  }

  private async isRunnerBusy(state: ChatState): Promise<boolean> {
    const status = await state.runner.getRuntimeStatus();
    return status.isStreaming || status.isCompacting || status.pendingMessages > 0;
  }

  private async processQueueIfIdle(): Promise<void> {
    const state = this.state;
    if (!state || !state.queue.length || await this.isBusy(state)) return;
    await this.processQueue(state);
  }

  private async processQueue(state: ChatState): Promise<void> {
    if (state.processingQueue) return;
    state.processingQueue = true;

    try {
      while (state.queue.length) {
        if (await this.isRunnerBusy(state)) break;

        const next = state.queue.shift();
        if (!next) continue;
        await this.submitMessage(next, state);
      }
    } finally {
      state.processingQueue = false;
    }
  }

  private async submitMessage(message: ChatMessage, state: ChatState): Promise<void> {
    const typingInterval = setInterval(() => {
      this.adapter
        .sendTyping(message.chatId)
        .catch((error) =>
          log.warn(`[chat ${message.chatId}] typing failed`, error),
        );
    }, 4_000);

    try {
      await this.adapter.sendTyping(message.chatId);
      const startedAt = Date.now();
      const prompt = formatPrompt(message.text.trim(), message.attachments);
      await state.runner.run(prompt);
      log.info(`[chat ${message.chatId}] message submitted`, {
        durationMs: Date.now() - startedAt,
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

function createTurnStreamSender(adapter: ChatAdapter, target: ChatTarget) {
  const toolOutput = createTextStreamSender(adapter, target);
  const answerOutput = createTextStreamSender(adapter, target);

  return {
    pushText(delta: string) {
      answerOutput.append(delta);
    },
    pushToolStart(event: ToolEvent) {
      toolOutput.append(`${formatToolStart(event)}\n`, { immediate: true });
    },
    async finish(fallbackText: string) {
      await toolOutput.finish();
      await answerOutput.finish(fallbackText);
    },
  };
}

function createTextStreamSender(adapter: ChatAdapter, target: ChatTarget) {
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
    stream = await adapter.startTextStream(target.chatId, {
      render: "markdown",
      replyToMessageId: target.replyToMessageId,
    });
    return stream;
  };

  const queue = (task: () => Promise<void>) => {
    pending = pending.then(task).catch((error) => {
      log.warn(`[chat ${target.chatId}] response stream failed`, error);
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
    append(delta: string, options: { immediate?: boolean } = {}) {
      text += delta;
      if (options.immediate) {
        update();
        return;
      }
      scheduleUpdate();
    },
    async finish(fallbackText = "") {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = undefined;
      }
      await pending;
      const finalText = text.trim() || fallbackText.trim();
      if (!finalText) return;
      const activeStream = await startStream();
      if (activeStream) {
        await activeStream.finish(finalText);
        return;
      }
      await adapter.sendMessage(target.chatId, finalText, {
        render: "markdown",
        replyToMessageId: target.replyToMessageId,
      });
    },
  };
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const text = contentToText(record.content).trim();
    if (text) return text;
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" ? stringValue(record.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

