import type {
  ChatAdapter,
  ChatCallback,
  ChatMessage,
  InlineButton,
  ChatCommand,
} from "../adapters/types.ts";
import type { ThinkingLevel } from "../pi/runner.ts";
import type { ChatState, ChatStateGetter } from "./chat-runtime.ts";
import {
  MODELS_HOME,
  RESUME_PREFIX,
  THINKING_PREFIX,
  WORKSPACE_PREFIX,
  modelButtons,
  providerButtons,
  resumeButtons,
  thinkingButtons,
  workspaceButtons,
} from "./chat-command-buttons.ts";
import {
  formatHelp,
  formatModelLine,
  formatModelMenu,
  formatProviderMenu,
  formatRecentMessages,
  formatResumeMenu,
  formatSessionLabel,
  formatStatus,
  formatThinkingMenu,
  formatWorkspaceMenu,
} from "./chat-command-format.ts";

export const CHAT_COMMANDS: ChatCommand[] = [
  { command: "status", description: "Show current session status" },
  { command: "workspaces", description: "Switch workspace" },
  { command: "models", description: "Choose model" },
  { command: "thinking", description: "Set thinking level" },
  { command: "resume", description: "Resume a previous session" },
  { command: "recent", description: "Show recent session messages" },
  { command: "new", description: "Start a new session" },
  { command: "stop", description: "Abort current task" },
  { command: "compact", description: "Compact context" },
  { command: "reload", description: "Reload current pi session" },
  { command: "exit", description: "Exit pi-pilot process" },
  { command: "start", description: "Welcome and quick start" },
  { command: "help", description: "Show available commands" },
];

type ActivityState = {
  state: ChatState;
  busy: boolean;
  streaming: boolean;
  compacting: boolean;
  queued: number;
};

export class ChatCommands {
  constructor(
    private readonly adapter: ChatAdapter,
    private readonly getState: ChatStateGetter,
    private readonly onExitRequest?: () => Promise<void> | void,
  ) {}

  async handleMessage(message: ChatMessage): Promise<boolean> {
    const command = parseCommand(message.text);
    if (!command) return false;

    if (command === "start") {
      await this.sendStart(message);
      return true;
    }

    if (command === "help") {
      await this.sendHelp(message);
      return true;
    }

    if (command === "status") {
      await this.sendStatus(message.chatId, message.messageId);
      return true;
    }

    if (command === "models") {
      await this.sendModelProviders(message.chatId, message.messageId);
      return true;
    }

    if (command === "thinking") {
      await this.sendThinkingMenu(message.chatId, message.messageId);
      return true;
    }

    if (command === "workspaces") {
      await this.sendWorkspaceMenu(message.chatId, message.messageId);
      return true;
    }

    if (command === "resume") {
      await this.sendResumeMenu(message.chatId, message.messageId);
      return true;
    }

    if (command === "recent") {
      await this.sendRecentMessages(message.chatId, message.messageId);
      return true;
    }

    if (command === "new") {
      await this.sendNewSession(message.chatId, message.messageId);
      return true;
    }

    if (command === "stop") {
      await this.sendStop(message.chatId, message.messageId);
      return true;
    }

    if (command === "compact") {
      await this.sendCompact(message.chatId, message.messageId);
      return true;
    }

    if (command === "reload") {
      await this.sendReload(message.chatId, message.messageId);
      return true;
    }

    if (command === "exit") {
      await this.sendExit(message.chatId, message.messageId);
      return true;
    }

    return false;
  }

  private async sendStart(message: ChatMessage): Promise<void> {
    await this.adapter.sendMessage(
      message.chatId,
      "Welcome. Send me a coding request directly, or use /help to see available commands.",
      { replyToMessageId: message.messageId },
    );
  }

  private async sendHelp(message: ChatMessage): Promise<void> {
    await this.adapter.sendMessage(message.chatId, formatHelp(CHAT_COMMANDS), {
      replyToMessageId: message.messageId,
    });
  }

  async handleCallback(callback: ChatCallback): Promise<void> {
    try {
      if (callback.data === MODELS_HOME) {
        await this.editModelProviders(callback);
        await this.adapter.answerCallback(callback);
        return;
      }

      if (callback.data.startsWith("models:provider:")) {
        const provider = decodeURIComponent(
          callback.data.slice("models:provider:".length),
        );
        await this.editProviderModels(callback, provider);
        await this.adapter.answerCallback(callback);
        return;
      }

      if (callback.data.startsWith("models:set:")) {
        await this.selectModel(callback);
        return;
      }

      if (callback.data.startsWith(`${RESUME_PREFIX}:`)) {
        await this.selectResumeSession(callback);
        return;
      }

      if (callback.data.startsWith(`${THINKING_PREFIX}:`)) {
        await this.selectThinkingLevel(callback);
        return;
      }

      if (callback.data.startsWith(`${WORKSPACE_PREFIX}:`)) {
        await this.selectWorkspace(callback);
        return;
      }

      await this.adapter.answerCallback(callback, "Unknown action");
    } catch (error) {
      console.error(`[chat ${callback.chatId}] callback failed`, error);
      await this.adapter.answerCallback(
        callback,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async sendStop(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const activity = await this.getActivityState(chatId);
    if (!activity.busy && !activity.streaming && activity.queued === 0) {
      await this.adapter.sendMessage(chatId, "Nothing to stop - no task is running.", {
        replyToMessageId,
      });
      return;
    }
    activity.state.queue.length = 0;
    await activity.state.runner.abort();
    await this.adapter.sendMessage(
      chatId,
      `Task aborted. Cleared ${activity.queued} queued message${activity.queued === 1 ? "" : "s"}.`,
      { replyToMessageId },
    );
  }

  private async sendCompact(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const activity = await this.getActivityState(chatId);
    if (activity.compacting) {
      await this.adapter.sendMessage(chatId, "Compaction is already running.", {
        replyToMessageId,
      });
      return;
    }
    if (activity.busy || activity.streaming || activity.queued > 0) {
      await this.adapter.sendMessage(
        chatId,
        "Cannot compact while a task is running or messages are queued. Use /stop or wait for completion.",
        { replyToMessageId },
      );
      return;
    }

    await activity.state.runner.compact();
  }

  private async sendResumeMenu(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    const sessions = await state.runner.listSessions();
    if (!sessions.length) {
      await this.adapter.sendMessage(chatId, "No previous sessions found.", { replyToMessageId });
      return;
    }
    await this.adapter.sendMessage(chatId, formatResumeMenu(sessions), {
      replyToMessageId,
      buttons: resumeButtons(sessions),
    });
  }

  private async sendWorkspaceMenu(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    const workspaces = state.runner.listWorkspaces();
    await this.adapter.sendMessage(chatId, formatWorkspaceMenu(workspaces), {
      replyToMessageId,
      buttons: workspaceButtons(workspaces),
    });
  }

  private async sendThinkingMenu(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    const status = await state.runner.getStatus();
    const levels = await state.runner.getAvailableThinkingLevels();
    await this.adapter.sendMessage(chatId, formatThinkingMenu(levels, status.thinkingLevel, status.model), {
      replyToMessageId,
      buttons: thinkingButtons(levels, status.thinkingLevel),
    });
  }

  private async sendRecentMessages(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    const messages = await state.runner.getRecentMessages();
    await this.adapter.sendMessage(chatId, formatRecentMessages(messages), { replyToMessageId });
  }

  private async sendNewSession(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const activity = await this.requireIdleMessage(
      chatId,
      replyToMessageId,
      "Cannot start a new session while a task is running or compaction is in progress. Use /stop or wait for completion.",
    );
    if (!activity) return;

    const sessionId = await activity.state.runner.newSession();
    await this.adapter.sendMessage(
      chatId,
      `New session started.\nSession: ${sessionId.slice(0, 8)}`,
      { replyToMessageId },
    );
  }

  private async selectResumeSession(callback: ChatCallback): Promise<void> {
    const rawIndex = callback.data.slice(`${RESUME_PREFIX}:`.length);
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) throw new Error("Invalid session index");

    const activity = await this.requireIdleCallback(callback, "Cannot switch session while a task is running");
    if (!activity) return;

    const target = await activity.state.runner.switchSession(index);
    const label = formatSessionLabel(target);
    await this.editCallbackMessage(callback, `Resumed session:\n${label}`, []);
    await this.adapter.answerCallback(callback, `Resumed ${target.id.slice(0, 8)}`);
  }

  private async selectWorkspace(callback: ChatCallback): Promise<void> {
    const rawIndex = callback.data.slice(`${WORKSPACE_PREFIX}:`.length);
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) throw new Error("Invalid workspace index");

    const activity = await this.requireIdleCallback(callback, "Cannot switch workspace while a task is running");
    if (!activity) return;

    const workspace = await activity.state.runner.switchWorkspace(index);
    await this.editCallbackMessage(callback, `Workspace selected:\nWorkspace: ${workspace.cwd}`, []);
    await this.adapter.answerCallback(callback, "Workspace selected");
    await this.sendStatus(callback.chatId);
  }

  private async selectThinkingLevel(callback: ChatCallback): Promise<void> {
    const rawLevel = callback.data.slice(`${THINKING_PREFIX}:`.length);
    if (!isThinkingLevel(rawLevel)) throw new Error("Invalid thinking level");

    const activity = await this.requireIdleCallback(callback, "Cannot change thinking while a task is running");
    if (!activity) return;

    const level = await activity.state.runner.setThinkingLevel(rawLevel);
    const levels = await activity.state.runner.getAvailableThinkingLevels();
    const status = await activity.state.runner.getStatus();
    await this.editCallbackMessage(
      callback,
      formatThinkingMenu(levels, level, status.model),
      thinkingButtons(levels, level),
    );
    await this.adapter.answerCallback(callback, `Thinking set to ${level}`);
  }

  private async sendReload(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const activity = await this.requireIdleMessage(
      chatId,
      replyToMessageId,
      "Cannot reload while a task is running or messages are queued. Use /stop or wait for completion.",
    );
    if (!activity) return;

    await activity.state.runner.reload();
    await this.adapter.sendMessage(chatId, "Reloaded current pi session.", { replyToMessageId });
    await this.sendStatus(chatId);
  }

  private async sendExit(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    await this.adapter.sendMessage(
      chatId,
      "Exiting pi-pilot. Docker will restart it if restart policy is enabled.",
      { replyToMessageId },
    );
    setTimeout(() => {
      void this.onExitRequest?.();
    }, 100);
  }

  private async sendStatus(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    await this.adapter.sendMessage(
      chatId,
      formatStatus(await state.runner.getStatus(), state.busy, state.queue.length),
      {
        replyToMessageId,
      },
    );
  }

  private async sendModelProviders(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getState();
    const groups = await state.runner.getProviderModels();
    const status = await state.runner.getStatus();
    await this.adapter.sendMessage(chatId, formatProviderMenu(groups, status.model, status.thinkingLevel), {
      replyToMessageId,
      buttons: providerButtons(groups),
    });
  }

  private async editModelProviders(callback: ChatCallback): Promise<void> {
    const state = await this.getState();
    const groups = await state.runner.getProviderModels();
    const status = await state.runner.getStatus();
    await this.editCallbackMessage(
      callback,
      formatProviderMenu(groups, status.model, status.thinkingLevel),
      providerButtons(groups),
    );
  }

  private async editProviderModels(
    callback: ChatCallback,
    provider: string,
  ): Promise<void> {
    const state = await this.getState();
    const groups = await state.runner.getProviderModels();
    const group = groups.find((item) => item.provider === provider);
    if (!group) throw new Error(`No available models for ${provider}`);

    await this.editCallbackMessage(
      callback,
      formatModelMenu(group),
      modelButtons(group),
    );
  }

  private async selectModel(callback: ChatCallback): Promise<void> {
    const [, , encodedProvider, rawIndex] = callback.data.split(":");
    if (!encodedProvider || rawIndex === undefined)
      throw new Error("Invalid model selection");

    const provider = decodeURIComponent(encodedProvider);
    const modelIndex = Number(rawIndex);
    if (!Number.isInteger(modelIndex)) throw new Error("Invalid model index");

    const state = await this.getState();
    const model = await state.runner.setModel(provider, modelIndex);
    const status = await state.runner.getStatus();

    await this.editCallbackMessage(
      callback,
      `Selected model:\n${formatModelLine(model.provider, model.name, status.thinkingLevel)}`,
      [[{ text: "Back to providers", callbackData: MODELS_HOME }]],
    );
    await this.adapter.answerCallback(callback, `Model set to ${model.name}`);
  }

  private async getActivityState(chatId: string): Promise<ActivityState> {
    const state = await this.getState();
    const runtimeStatus = await state.runner.getRuntimeStatus();
    return {
      state,
      busy: state.busy,
      streaming: runtimeStatus.isStreaming,
      compacting: runtimeStatus.isCompacting,
      queued: state.queue.length,
    };
  }

  private async requireIdleMessage(
    chatId: string,
    replyToMessageId: string | undefined,
    message: string,
  ): Promise<ActivityState | undefined> {
    const activity = await this.getActivityState(chatId);
    if (!isActive(activity)) return activity;

    await this.adapter.sendMessage(chatId, message, { replyToMessageId });
    return undefined;
  }

  private async requireIdleCallback(
    callback: ChatCallback,
    message: string,
  ): Promise<ActivityState | undefined> {
    const activity = await this.getActivityState(callback.chatId);
    if (!isActive(activity)) return activity;

    await this.adapter.answerCallback(callback, message);
    return undefined;
  }

  private async editCallbackMessage(
    callback: ChatCallback,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void> {
    if (!callback.messageId) {
      await this.adapter.sendMessage(callback.chatId, text, { buttons });
      return;
    }
    await this.adapter.editMessage(callback.chatId, callback.messageId, text, {
      buttons,
    });
  }
}

function isActive(activity: ActivityState): boolean {
  return activity.busy || activity.streaming || activity.compacting || activity.queued > 0;
}

function parseCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/(\w+)(?:@\w+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}
