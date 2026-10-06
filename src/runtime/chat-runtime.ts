import type { RuntimeConfig } from "../config/runtime.ts";
import type {
  ChatAttachment,
  ChatAdapter,
  ChatCallback,
  ChatMessage,
} from "../adapters/types.ts";
import type { RunnerEvent } from "../pi/events.ts";
import { logger } from "../logger.ts";
import { PiRunner } from "../pi/runner.ts";
import { ChatCommands } from "./chat-commands.ts";

import {
  createTurnStreamSender,
  type ChatTarget,
} from "../render/turn-stream.ts";

const log = logger.child("runtime");

export type ChatState = {
  runner: PiRunner;
};

export type ChatStateGetter = () => Promise<ChatState>;

export type ChatRuntimeOptions = {
  onExitRequest?: () => Promise<void> | void;
  runner?: PiRunner;
};

export class ChatRuntime {
  private state: ChatState | undefined;
  private initPromise: Promise<void> | undefined;
  private currentOutput: ReturnType<typeof createTurnStreamSender> | undefined;
  private typingTimer: Timer | undefined;
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

    await this.enqueueMessage(
      routedMessage,
      `telegram:${message.chatId}:${message.messageId}`,
    );
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
    if (this.initPromise) return this.initPromise;
    if (this.state) return;

    this.initPromise = this.initializeState();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }
  getWorkspaceDirectory(): string {
    return this.runner.getWorkspaceDirectory();
  }

  async dispose(): Promise<void> {
    await this.initPromise;
    if (!this.state) return;
    this.stopTyping();
    await this.state.runner.dispose();
    this.stopTyping();
    this.state = undefined;
    await this.currentOutput?.cancel();
    this.currentOutput = undefined;
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedActorIds.includes(userId);
  }

  private defaultNotificationTarget(): ChatTarget | undefined {
    const chatId =
      this.config.defaultTargetId ?? this.config.allowedActorIds[0];
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

    runner.setOutputCallback((event) => this.handleRunnerOutput(event));

    await runner.init();
    this.state = state;
  }

  private async handleRunnerOutput(event: RunnerEvent): Promise<void> {
    switch (event.type) {
      case "submission_failed": {
        const target = this.getNotificationTarget("submission failure");
        if (target)
          await this.adapter.sendMessage(
            target.chatId,
            `Pi failed: ${event.message}`,
          );
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
      case "conversation_attached":
        await this.currentOutput?.cancel();
        this.currentOutput = undefined;
        this.stopTyping();
        return;
      case "run_started":
        await this.currentOutput?.finish("");
        this.currentOutput = undefined;
        this.startTyping();
        return;
      case "assistant_text":
        await this.getOrCreateOutput()?.pushAssistantText(
          event.messageId,
          event.text,
        );
        return;
      case "tool_execution_start":
        await this.getOrCreateOutput()?.pushToolStart(event);
        return;
      case "run_finished": {
        const output =
          this.currentOutput ??
          (event.emptyAnswer ? this.getOrCreateOutput() : undefined);
        this.currentOutput = undefined;
        await output?.finish(event.emptyAnswer ? "(no response)" : "");
        this.stopTyping();
        return;
      }
    }
  }

  private getNotificationTarget(kind: string): ChatTarget | undefined {
    const target = this.defaultNotificationTarget();
    if (!target) log.warn(`dropping ${kind}: no target chat configured`);
    return target;
  }

  private getOrCreateOutput():
    | ReturnType<typeof createTurnStreamSender>
    | undefined {
    if (this.currentOutput) return this.currentOutput;

    const target = this.getNotificationTarget("runner output");
    if (!target) return undefined;

    this.currentOutput = createTurnStreamSender(this.adapter, target);
    return this.currentOutput;
  }

  private async sendCompactionStart(
    target: ChatTarget,
    reason: "manual" | "threshold" | "overflow",
  ): Promise<void> {
    const label =
      reason === "manual"
        ? "manual"
        : reason === "threshold"
          ? "threshold reached"
          : "context overflow";
    await this.adapter.sendMessage(
      target.chatId,
      `🔄 Compacting context (${label})...`,
    );
  }

  private async sendCompactionEnd(
    target: ChatTarget,
    event: Extract<RunnerEvent, { type: "compaction_end" }>,
  ): Promise<void> {
    if (event.aborted) {
      await this.adapter.sendMessage(target.chatId, "⚠️ Compaction aborted.");
      return;
    }
    if (event.errorMessage) {
      await this.adapter.sendMessage(
        target.chatId,
        `❌ Compaction failed: ${event.errorMessage}`,
      );
      return;
    }
    if (event.skipped) {
      await this.adapter.sendMessage(
        target.chatId,
        "Context is too short to compact.",
      );
      return;
    }
    await this.adapter.sendMessage(target.chatId, "✅ Context compacted.");
  }

  private async enqueueMessage(
    message: ChatMessage,
    requestId: string,
  ): Promise<void> {
    const state = await this.getState();
    try {
      // Every input goes straight to the durable inbox. The harness owns ordering
      // and steering, including when a run ends during admission.
      const input = await state.runner.submit(
        formatPrompt(message.text.trim(), message.attachments),
        {
          whenBusy: "steer",
          requestId,
          workspace: message.workspace,
        },
      );
      if (input.queued && message.messageId) {
        await this.adapter
          .reactToMessage(message.chatId, message.messageId, "👀")
          .catch((error) => log.warn("message reaction failed", error));
      }
    } catch (error) {
      await this.adapter.sendMessage(
        message.chatId,
        `Pi failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private startTyping(): void {
    this.stopTyping();
    const send = () => {
      const target = this.defaultNotificationTarget();
      if (target)
        void this.adapter
          .sendTyping(target.chatId)
          .catch((error) => log.warn("typing failed", error));
    };
    send();
    this.typingTimer = setInterval(send, 4_000);
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }
}

function formatPrompt(text: string, attachments?: ChatAttachment[]): string {
  if (!attachments?.length) return text;
  const fileList = attachments.map((a) => a.file).join("\n");
  const prefix = `<attached>\n${fileList}\n</attached>`;
  return text ? `${prefix}\n${text}` : prefix;
}
