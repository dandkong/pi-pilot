import type {
  ChatAdapter,
  ChatCallback,
  ChatMessage,
  InlineButton,
  TelegramCommand,
} from "../adapters/types.ts";
import type { ProviderModels, RunnerStatus } from "../pi/runner.ts";
import type { ChatStateGetter } from "./chat-runtime.ts";

const MODELS_HOME = "models:home";

export const TELEGRAM_COMMANDS: TelegramCommand[] = [
  { command: "start", description: "Welcome and quick start" },
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show current session status" },
  { command: "models", description: "Choose model" },
  { command: "stop", description: "Abort current task" },
  { command: "compact", description: "Compact context" },
];

export class ChatCommands {
  constructor(
    private readonly adapter: ChatAdapter,
    private readonly getChatState: ChatStateGetter,
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

    if (command === "stop") {
      await this.sendStop(message.chatId, message.messageId);
      return true;
    }

    if (command === "compact") {
      await this.sendCompact(message.chatId, message.messageId);
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
    const state = await this.getChatState(chatId);
    const runtimeStatus = await state.runner.getRuntimeStatus();
    const queued = state.queue.length;
    if (!state.busy && !runtimeStatus.isStreaming && queued === 0) {
      await this.adapter.sendMessage(chatId, "Nothing to stop - no task is running.", {
        replyToMessageId,
      });
      return;
    }
    state.queue.length = 0;
    await state.runner.abort();
    await this.adapter.sendMessage(
      chatId,
      `Task aborted. Cleared ${queued} queued message${queued === 1 ? "" : "s"}.`,
      { replyToMessageId },
    );
  }

  private async sendCompact(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getChatState(chatId);
    const runtimeStatus = await state.runner.getRuntimeStatus();
    if (runtimeStatus.isCompacting) {
      await this.adapter.sendMessage(chatId, "Compaction is already running.", {
        replyToMessageId,
      });
      return;
    }
    if (state.busy || runtimeStatus.isStreaming || state.queue.length > 0) {
      await this.adapter.sendMessage(
        chatId,
        "Cannot compact while a task is running or messages are queued. Use /stop or wait for completion.",
        { replyToMessageId },
      );
      return;
    }

    await state.runner.compact();
    const status = await state.runner.getStatus();
    const context = status.context
      ? `${formatNumber(status.context.tokens)} / ${formatNumber(status.context.contextWindow)}`
      : "unknown";
    await this.adapter.sendMessage(
      chatId,
      `Context compacted.\nContext: ${context}`,
      { replyToMessageId },
    );
  }

  private async sendStatus(
    chatId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = await this.getChatState(chatId);
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
    const state = await this.getChatState(chatId);
    const groups = await state.runner.getProviderModels();
    await this.adapter.sendMessage(chatId, formatProviderMenu(groups), {
      replyToMessageId,
      buttons: providerButtons(groups),
    });
  }

  private async editModelProviders(callback: ChatCallback): Promise<void> {
    const state = await this.getChatState(callback.chatId);
    const groups = await state.runner.getProviderModels();
    await this.editCallbackMessage(
      callback,
      formatProviderMenu(groups),
      providerButtons(groups),
    );
  }

  private async editProviderModels(
    callback: ChatCallback,
    provider: string,
  ): Promise<void> {
    const state = await this.getChatState(callback.chatId);
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

    const state = await this.getChatState(callback.chatId);
    const model = await state.runner.setModel(provider, modelIndex);
    const status = await state.runner.getStatus();

    await this.editCallbackMessage(
      callback,
      `Selected model:\n${formatModelLine(model.provider, model.name, status.thinkingLevel)}`,
      [[{ text: "Back to providers", callbackData: MODELS_HOME }]],
    );
    await this.adapter.answerCallback(callback, `Model set to ${model.name}`);
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
    `CWD: ${status.cwd}`,
    `Session: ${session}`,
    `Busy: ${busy || status.isStreaming ? "yes" : "no"}`,
    `Streaming: ${status.isStreaming ? "yes" : "no"}`,
    `Compacting: ${status.isCompacting ? "yes" : "no"}`,
    `Queue: ${queuedMessages}`,
    `Messages: ${status.stats.totalMessages} (${status.stats.userMessages} user / ${status.stats.assistantMessages} assistant)`,
    `Tools: ${status.activeTools.length} active`,
    `Cost: ${cost}`,
  ].join("\n");
}

function formatProviderMenu(groups: ProviderModels[]): string {
  if (!groups.length) return "No available models. Check your pi auth/config.";
  return "Choose a provider:";
}

function formatModelMenu(group: ProviderModels): string {
  return `Choose a model from ${group.displayName}:`;
}

function providerButtons(groups: ProviderModels[]): InlineButton[][] {
  return chunkButtons(
    groups.map((group) => ({
      text: `${group.displayName} (${group.models.length})`,
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
  return `(${provider}) ${modelName} • ${thinkingLevel}`;
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : Math.round(value).toLocaleString("en-US");
}
