import {
  AuthStorage,
  createAgentSession,
  type AgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.ts";
import { logger } from "../logger.ts";

const log = logger.child("pi");

type ModelInfo = ReturnType<ModelRegistry["getAvailable"]>[number];

export type ProviderModels = {
  provider: string;
  displayName: string;
  models: ModelInfo[];
};

export type ToolEvent = {
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
  result?: unknown;
  isError?: unknown;
};

export type RunOptions = {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (event: ToolEvent) => void | Promise<void>;
};

export type RunnerStatus = {
  cwd: string;
  sessionId: string;
  model?: ModelInfo;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    cost: number;
  };
  activeTools: string[];
};

export type RuntimeStatus = {
  isStreaming: boolean;
  isCompacting: boolean;
};

export class PiRunner {
  private session: AgentSession | undefined;
  private modelRegistry: ModelRegistry | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(private readonly config: AppConfig) {}

  async init(): Promise<void> {
    if (this.session) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.createSession();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  async run(prompt: string, options?: RunOptions): Promise<string> {
    const session = await this.getSession();
    let answer = "";
    let callbackQueue = Promise.resolve();

    const runCallback = (callback: () => void | Promise<void>) => {
      try {
        const result = callback();
        callbackQueue = callbackQueue.then(() => result).catch((error) => {
          log.warn("run event callback failed", error);
        });
      } catch (error) {
        log.warn("run event callback failed", error);
      }
    };

    log.info("prompt start", {
      sessionId: session.sessionId,
      model: session.model ? `${session.model.provider}/${session.model.name}` : undefined,
      inputLength: prompt.length,
      text: prompt,
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        answer += event.assistantMessageEvent.delta;
        options?.onTextDelta?.(event.assistantMessageEvent.delta);
        return;
      }
      if (event.type === "tool_execution_start") {
        runCallback(() => options?.onToolStart?.(event));
      }
      logAgentEvent(event);
    });

    const startedAt = Date.now();
    try {
      await session.prompt(prompt, { source: "rpc" });
      await callbackQueue;
      const finalAnswer = answer.trim();
      log.info("prompt end", {
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        outputLength: finalAnswer.length,
        text: finalAnswer,
      });
      return finalAnswer;
    } finally {
      unsubscribe();
    }
  }

  async getStatus(): Promise<RunnerStatus> {
    const session = await this.getSession();
    const stats = session.getSessionStats();
    return {
      cwd: this.config.cwd,
      sessionId: session.sessionId,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      context: session.getContextUsage(),
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        totalMessages: stats.totalMessages,
        cost: stats.cost,
      },
      activeTools: session.getActiveToolNames(),
    };
  }

  async getProviderModels(): Promise<ProviderModels[]> {
    await this.getSession();
    const registry = this.getModelRegistry();
    const models = registry.getAvailable().sort(compareModels);
    const groups = new Map<string, ModelInfo[]>();

    for (const model of models) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }

    return [...groups.entries()].map(([provider, providerModels]) => ({
      provider,
      displayName: registry.getProviderDisplayName(provider),
      models: providerModels,
    }));
  }

  async setModel(provider: string, modelIndex: number): Promise<ModelInfo> {
    const session = await this.getSession();
    const providerModels = (await this.getProviderModels()).find((group) => group.provider === provider)?.models ?? [];
    const model = providerModels[modelIndex];
    if (!model) throw new Error(`Unknown model selection: ${provider} #${modelIndex}`);

    await session.setModel(model);
    return model;
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const session = await this.getSession();
    return {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
    };
  }

  async abort(): Promise<void> {
    const session = await this.getSession();
    session.clearQueue();
    await session.abort();
  }

  async compact(): Promise<void> {
    const session = await this.getSession();
    await session.compact();
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
    this.modelRegistry = undefined;
  }

  private async createSession(): Promise<void> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const settingsManager = SettingsManager.create(this.config.cwd);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.config.cwd,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
    });

    if (modelFallbackMessage) {
      log.warn("model fallback", modelFallbackMessage);
    }

    this.modelRegistry = modelRegistry;
    this.session = session;

    const skills = session.resourceLoader.getSkills().skills;
    log.info("session initialized", {
      cwd: this.config.cwd,
      sessionId: session.sessionId,
      model: session.model ? `${session.model.provider}/${session.model.name}` : undefined,
      thinkingLevel: session.thinkingLevel,
      activeTools: session.getActiveToolNames(),
      skills: skills.map((skill) => skill.name),
    });
  }

  private async getSession(): Promise<AgentSession> {
    await this.init();
    if (!this.session) throw new Error("Pi session was not initialized");
    return this.session;
  }

  private getModelRegistry(): ModelRegistry {
    if (!this.modelRegistry) throw new Error("Pi model registry was not initialized");
    return this.modelRegistry;
  }
}

function logAgentEvent(event: unknown): void {
  if (!event || typeof event !== "object" || !("type" in event)) return;
  const typedEvent = event as Record<string, unknown>;
  const type = typedEvent.type;

  if (type === "tool_execution_start") {
    log.info("tool start", {
      toolName: typedEvent.toolName,
      toolCallId: typedEvent.toolCallId,
      args: typedEvent.args,
    });
    return;
  }

  if (type === "tool_execution_end") {
    log.info("tool end", {
      toolName: typedEvent.toolName,
      toolCallId: typedEvent.toolCallId,
      isError: typedEvent.isError,
      result: typedEvent.result,
    });
    return;
  }

  if (type === "auto_retry_start" || type === "auto_retry_end" || type === "compaction_start" || type === "compaction_end") {
    log.info(String(type), typedEvent);
  }
}

function compareModels(a: ModelInfo, b: ModelInfo): number {
  return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
