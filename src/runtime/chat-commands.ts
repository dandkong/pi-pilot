import type {
  ChatAdapter,
  ChatCallback,
  ChatMessage,
  InlineButton,
  TelegramCommand,
} from "../adapters/types.ts";
import type { ModelInfo, ProviderModels, RecentMessage, RunnerStatus } from "../pi/runner.ts";
import type { SessionListItem, ThinkingLevel, WorkspaceListItem } from "../pi/runner.ts";
import type { ChatState, ChatStateGetter } from "./chat-runtime.ts";

const MODELS_HOME = "models:home";
const RESUME_PREFIX = "resume";
const THINKING_PREFIX = "thinking";
const WORKSPACE_PREFIX = "workspace";

export const TELEGRAM_COMMANDS: TelegramCommand[] = [
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
    await this.adapter.sendMessage(message.chatId, formatHelp(), {
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

function formatHelp(): string {
  return [
    "Available commands:",
    ...TELEGRAM_COMMANDS.map((item) => `/${item.command} - ${item.description}`),
    "",
    "You can also send a request directly.",
  ].join("\n");
}

function parseCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/(\w+)(?:@\w+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
}

function formatStatus(status: RunnerStatus, busy: boolean, queuedMessages: number): string {
  const model = status.model
    ? formatModelLine(
        status.model.provider,
        status.model.name,
        status.thinkingLevel,
      )
    : "No model selected";
  const context = status.context
    ? `${formatNumber(status.context.tokens)} / ${formatNumber(status.context.contextWindow)}${
        status.context.percent === null
          ? ""
          : ` (${status.context.percent.toFixed(1)}%)`
      }`
    : "unknown";
  const session = status.sessionId.slice(0, 8);
  const cost = status.stats.cost ? `$${status.stats.cost.toFixed(4)}` : "$0";

  return [
    "Status",
    `Model: ${model}`,
    `Context: ${context}`,
    `Workspace: ${status.cwd}`,
    `Session: ${session}`,
    `Busy: ${busy || status.isStreaming ? "yes" : "no"}`,
    `Streaming: ${status.isStreaming ? "yes" : "no"}`,
    `Compacting: ${status.isCompacting ? "yes" : "no"}`,
    `Queue: ${queuedMessages}`,
    `Messages: ${status.stats.totalMessages} (${status.stats.userMessages} user / ${status.stats.assistantMessages} assistant)`,
    `Tools: ${status.activeTools.length}`,
    `Skills: ${status.skillCount}`,
    `Cost: ${cost}`,
  ].join("\n");
}

function formatProviderMenu(
  groups: ProviderModels[],
  currentModel?: ModelInfo,
  thinkingLevel?: string,
): string {
  if (!groups.length) return "No available models. Check your pi auth/config.";
  const current = currentModel
    ? `Current: ${formatCurrentModel(currentModel, thinkingLevel)}\n\n`
    : "";
  return `${current}Choose a provider:`;
}

function formatWorkspaceMenu(workspaces: WorkspaceListItem[]): string {
  return [
    "Choose workspace:",
    ...workspaces.map((workspace, index) =>
      `${index + 1}. ${workspace.cwd}${workspace.current ? " (current)" : ""}`,
    ),
  ].join("\n");
}

function formatThinkingMenu(
  levels: ThinkingLevel[],
  currentLevel: string,
  currentModel?: ModelInfo,
): string {
  if (!levels.length) return "Current model does not support thinking levels.";
  const current = currentModel
    ? formatCurrentModel(currentModel, currentLevel)
    : `thinking ${currentLevel}`;
  return `Current: ${current}\n\nChoose thinking level:`;
}

function formatResumeMenu(sessions: SessionListItem[]): string {
  if (!sessions.length) return "No previous sessions found.";
  return [
    "Resume a session:",
    ...sessions.map((s, index) => `${index + 1}. ${formatSessionLabel(s)}`),
  ].join("\n");
}

function formatRecentMessages(messages: RecentMessage[]): string {
  if (!messages.length) return "No recent user, assistant, or summary messages.";
  return messages
    .map((message) => `${recentRoleIcon(message.role)} ${truncate(normalizeRecentText(message.text), 100) ?? ""}`)
    .join("\n");
}

function recentRoleIcon(role: RecentMessage["role"]): string {
  if (role === "User") return "👤";
  if (role === "Assistant") return "🧑‍💻";
  return "📝";
}

function normalizeRecentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSessionLabel(session: SessionListItem): string {
  const id = session.id.slice(0, 8);
  const msgs = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;
  const label = session.name || truncate(session.firstMessage, 40) || "(no messages)";
  const time = formatRelativeTime(session.modified);
  return `${id} • ${msgs} - ${label} • ${time}`;
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function resumeButtons(sessions: SessionListItem[]): InlineButton[][] {
  return [sessions.map((_, index) => ({
    text: String(index + 1),
    callbackData: `${RESUME_PREFIX}:${index}`,
  }))];
}

function workspaceButtons(workspaces: WorkspaceListItem[]): InlineButton[][] {
  return chunkButtons(
    workspaces.map((_, index) => ({
      text: String(index + 1),
      callbackData: `${WORKSPACE_PREFIX}:${index}`,
    })),
    5,
  );
}

function thinkingButtons(levels: ThinkingLevel[], currentLevel: string): InlineButton[][] {
  return chunkButtons(
    levels.map((level) => ({
      text: level === currentLevel ? `${level} ✓` : level,
      callbackData: `${THINKING_PREFIX}:${level}`,
    })),
    3,
  );
}

function formatModelMenu(group: ProviderModels): string {
  return `Choose a model from ${group.provider}:`;
}

function providerButtons(groups: ProviderModels[]): InlineButton[][] {
  return chunkButtons(
    groups.map((group) => ({
      text: `${group.provider} (${group.models.length})`,
      callbackData: `models:provider:${encodeURIComponent(group.provider)}`,
    })),
    2,
  );
}

function modelButtons(group: ProviderModels): InlineButton[][] {
  const rows = chunkButtons(
    group.models.map((model, index) => ({
      text: model.name,
      callbackData: `models:set:${encodeURIComponent(group.provider)}:${index}`,
    })),
    2,
  );
  rows.push([{ text: "Back to providers", callbackData: MODELS_HOME }]);
  return rows;
}

function truncate(value: string | undefined, limit = 100): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function chunkButtons(
  buttons: InlineButton[],
  columns: number,
): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += columns) {
    rows.push(buttons.slice(i, i + columns));
  }
  return rows;
}

function formatModelLine(
  provider: string,
  modelName: string,
  thinkingLevel: string,
): string {
  return `${provider}/${modelName} • ${thinkingLevel}`;
}

function formatCurrentModel(model: ModelInfo, thinkingLevel?: string): string {
  return thinkingLevel
    ? formatModelLine(model.provider, model.name, thinkingLevel)
    : `${model.provider}/${model.name}`;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : Math.round(value).toLocaleString("en-US");
}
