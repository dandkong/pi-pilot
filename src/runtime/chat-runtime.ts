import type { RuntimeConfig } from "../config/runtime.ts";
import type {
  ChatAttachment,
  ChatAdapter,
  ChatCallback,
  ChatMessage,
  MessageRenderMode,
  SendMessageOptions,
} from "../adapters/types.ts";
import type { RunnerEvent } from "../pi/events.ts";
import { logger } from "../logger.ts";
import { PiRunner, type ToolEvent } from "../pi/runner.ts";
import { ChatCommands } from "./chat-commands.ts";

const log = logger.child("runtime");

export type ChatState = {
  runner: PiRunner;
};

export type ChatStateGetter = () => Promise<ChatState>;

type ChatTarget = {
  chatId: string;
  replyToMessageId?: string;
};

type AgentEndEvent = Extract<RunnerEvent, { type: "agent_end" }>;

export type ChatRuntimeOptions = {
  onExitRequest?: () => Promise<void> | void;
  runner?: PiRunner;
};

export class ChatRuntime {
  private state: ChatState | undefined;
  private initPromise: Promise<void> | undefined;
  private currentOutput: ReturnType<typeof createTurnStreamSender> | undefined;
  private outputQueue = Promise.resolve();
  private pendingAgentEnd: AgentEndEvent | undefined;
  private typingTimer: Timer | undefined;
  /** Steered messages pi has accepted but not yet injected into the running conversation. */
  private pendingSteering = 0;
  private readonly commands: ChatCommands;
  private readonly runner: PiRunner;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly adapter: ChatAdapter,
    options: ChatRuntimeOptions = {},
  ) {
    this.runner = options.runner ?? new PiRunner(config);
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

    await this.enqueueMessage(routedMessage, `telegram:${message.chatId}:${message.messageId}`);
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

  async dispose(): Promise<void> {
    if (!this.state) return;
    this.stopTyping();
    await this.state.runner.dispose();
    this.state = undefined;
    this.currentOutput = undefined;
    this.pendingAgentEnd = undefined;
    this.pendingSteering = 0;
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
    const runner = this.runner;
    const state = { runner };

    runner.setOutputCallback((event) => {
      this.outputQueue = this.outputQueue
        .then(() => this.handleRunnerOutput(event))
        .catch((error) => log.error("runner output handling failed", error));
      return this.outputQueue;
    });

    await runner.init();
    this.state = state;
  }

  private async handleRunnerOutput(event: RunnerEvent): Promise<void> {
    switch (event.type) {
      case "submission_failed": {
        const target = this.getNotificationTarget("submission failure");
        if (target) await this.adapter.sendMessage(target.chatId, `Pi failed: ${event.message}`);
        return;
      }
      case "segment_break":
        await this.currentOutput?.breakSegment();
        return;
      case "compaction_start": {
        // Finalize whatever the agent already streamed, so post-compaction
        // output starts a new Telegram message instead of being merged into
        // the pre-compaction one.
        await this.currentOutput?.breakSegment();
        const target = this.getNotificationTarget("compaction notification");
        if (target) await this.sendCompactionStart(target, event.reason);
        return;
      }
      case "compaction_end": {
        const target = this.getNotificationTarget("compaction notification");
        if (target) await this.sendCompactionEnd(target, event);
        return;
      }
      case "agent_start":
        this.startTyping();
        // A new agent loop can follow a retry or compaction. Close any text
        // from the preceding attempt before the new attempt starts.
        await this.currentOutput?.breakSegment();
        this.currentOutput = undefined;
        this.pendingAgentEnd = undefined;
        this.pendingSteering = 0;
        return;
      case "queue_update":
        await this.handleQueueUpdate(event);
        return;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          await this.getOrCreateOutput()?.pushText(event.assistantMessageEvent.delta);
        }
        return;
      case "tool_execution_start":
        await this.getOrCreateOutput()?.pushToolStart(event);
        return;
      case "agent_end":
        // The durable adapter emits this only once the run is terminal.
        this.pendingAgentEnd = event;
        return;
      case "agent_settled": {
        const agentEnd = this.pendingAgentEnd;
        this.pendingAgentEnd = undefined;
        const output = this.currentOutput ?? (agentEnd ? this.getOrCreateOutput() : undefined);
        this.currentOutput = undefined;
        await output?.finish(
          agentEnd ? extractLastAssistantText(agentEnd.messages) ||
            (agentEnd.messages.some((message) => message.stopReason === "stop" || message.stopReason === "length") ? "(no response)" : "") : "",
        );
        this.stopTyping();
        return;
      }
    }
  }

  /**
   * pi drains its steering queue when it injects a message into the running
   * conversation. Break the current output segment at that exact point so
   * everything produced after the interjection starts a new Telegram message
   * instead of being merged into the pre-interjection one.
   */
  private async handleQueueUpdate(
    event: Extract<RunnerEvent, { type: "queue_update" }>,
  ): Promise<void> {
    const queued = event.steering.length + event.followUp.length;
    const wasQueued = this.pendingSteering > 0;
    this.pendingSteering = queued;

    if (wasQueued && queued === 0) {
      await this.currentOutput?.breakSegment();
    }
  }

  private getNotificationTarget(kind: string): ChatTarget | undefined {
    const target = this.defaultNotificationTarget();
    if (!target) log.warn(`dropping ${kind}: no target chat configured`);
    return target;
  }

  private getOrCreateOutput(): ReturnType<typeof createTurnStreamSender> | undefined {
    if (this.currentOutput) return this.currentOutput;

    const target = this.getNotificationTarget("runner output");
    if (!target) return undefined;

    this.currentOutput = createTurnStreamSender(this.adapter, target);
    return this.currentOutput;
  }

  private async sendCompactionStart(target: ChatTarget, reason: "manual" | "threshold" | "overflow"): Promise<void> {
    const label = reason === "manual" ? "manual" : reason === "threshold" ? "threshold reached" : "context overflow";
    await this.adapter.sendMessage(target.chatId, `🔄 Compacting context (${label})...`);
  }

  private async sendCompactionEnd(target: ChatTarget, event: Extract<RunnerEvent, { type: "compaction_end" }>): Promise<void> {
    if (event.aborted) {
      await this.adapter.sendMessage(target.chatId, "⚠️ Compaction aborted.");
      return;
    }
    if (event.errorMessage) {
      await this.adapter.sendMessage(target.chatId, `❌ Compaction failed: ${event.errorMessage}`);
      return;
    }
    if (event.skipped) {
      await this.adapter.sendMessage(target.chatId, "Context is too short to compact.");
      return;
    }
    await this.adapter.sendMessage(target.chatId, "✅ Context compacted.");
  }

  private async enqueueMessage(message: ChatMessage, requestId: string): Promise<void> {
    const state = await this.getState();
    const status = await state.runner.getRuntimeStatus();
    const deferred = status.isStreaming || status.isCompacting || status.pendingMessages > 0;
    try {
      // Every input goes straight to the durable inbox. The harness owns ordering
      // and steering, including when a run ends during admission.
      await state.runner.run(formatPrompt(message.text.trim(), message.attachments), {
        streamingBehavior: "steer", requestId,
      });
      if (deferred && message.messageId) {
        await this.adapter.reactToMessage(message.chatId, message.messageId, "👀")
          .catch((error) => log.warn("message reaction failed", error));
      }
    } catch (error) {
      await this.adapter.sendMessage(message.chatId, `Pi failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startTyping(): void {
    this.stopTyping();
    const send = () => {
      const target = this.defaultNotificationTarget();
      if (target) void this.adapter.sendTyping(target.chatId).catch((error) => log.warn("typing failed", error));
    };
    send();
    this.typingTimer = setInterval(send, 4_000);
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }

}

function createTurnStreamSender(adapter: ChatAdapter, target: ChatTarget) {
  type SegmentKind = "text" | "tool";

  let currentOutput: ReturnType<typeof createTextStreamSender> | undefined;
  let currentKind: SegmentKind | undefined;
  let hasSentSegment = false;
  let pending = Promise.resolve();

  const switchTo = async (kind: SegmentKind) => {
    if (currentKind === kind && currentOutput) return currentOutput;

    if (currentOutput && await currentOutput.finish()) {
      hasSentSegment = true;
    }

    currentKind = kind;
    currentOutput = createTextStreamSender(adapter, target, kind === "tool" ? "plain" : "markdown");
    return currentOutput;
  };

  const queue = (task: () => Promise<void>) => {
    pending = enqueueStreamTask(pending, task, `[chat ${target.chatId}] turn stream failed`);
    return pending;
  };

  return {
    pushText(delta: string) {
      return queue(async () => {
        const output = await switchTo("text");
        output.append(delta);
      });
    },
    pushToolStart(event: ToolEvent) {
      return queue(async () => {
        const output = await switchTo("tool");
        output.append(`${formatToolStart(event)}\n`, { immediate: true });
      });
    },
    breakSegment() {
      return queue(async () => {
        if (currentOutput && await currentOutput.finish()) {
          hasSentSegment = true;
        }
        currentOutput = undefined;
        currentKind = undefined;
      });
    },
    async finish(fallbackText: string) {
      await pending;
      if (!currentOutput && !hasSentSegment && fallbackText.trim()) {
        currentKind = "text";
        currentOutput = createTextStreamSender(adapter, target, "markdown");
      }
      const sentCurrent = await currentOutput?.finish(hasSentSegment ? "" : fallbackText);
      hasSentSegment = hasSentSegment || !!sentCurrent;
    },
  };
}

function createTextStreamSender(adapter: ChatAdapter, target: ChatTarget, render: MessageRenderMode) {
  let text = "";
  let stream: Awaited<ReturnType<ChatAdapter["startTextStream"]>>;
  let streamStarted = false;
  let pending = Promise.resolve();
  let scheduled: Timer | undefined;
  const streamOptions: SendMessageOptions = {
    render,
    replyToMessageId: target.replyToMessageId,
  };
  // Rewriting a persisted Telegram message is rate limited, so the adapter owns
  // the cadence instead of the runtime hardcoding one.
  const minUpdateIntervalMs = adapter.getStreamUpdateIntervalMs();
  // Seed with the creation time so the first flush waits one full interval
  // rather than firing immediately on the very first token.
  let lastUpdatedAt = Date.now();

  const startStream = async () => {
    if (streamStarted) return stream;
    streamStarted = true;
    stream = await adapter.startTextStream(target.chatId, streamOptions);
    return stream;
  };

  const queue = (task: () => Promise<void>) => {
    pending = enqueueStreamTask(pending, task, `[chat ${target.chatId}] response stream failed`);
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
    // Sleep exactly until the next update becomes legal. A fixed retry tick
    // would silently cap the adapter's interval at the tick length.
    const delay = Math.max(0, minUpdateIntervalMs - (Date.now() - lastUpdatedAt));
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (Date.now() - lastUpdatedAt < minUpdateIntervalMs) {
        scheduleUpdate();
        return;
      }
      update();
    }, delay);
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
    async finish(fallbackText = ""): Promise<boolean> {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = undefined;
      }
      await pending;
      const finalText = text.trim() || fallbackText.trim();
      if (!finalText) return false;
      const activeStream = await startStream();
      if (activeStream) {
        await activeStream.finish(finalText);
        return true;
      }
      await adapter.sendMessage(target.chatId, finalText, {
        render,
        replyToMessageId: target.replyToMessageId,
      });
      return true;
    },
  };
}

function enqueueStreamTask(
  pending: Promise<void>,
  task: () => Promise<void>,
  errorMessage: string,
): Promise<void> {
  return pending.then(task).catch((error) => {
    log.warn(errorMessage, error);
  });
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

