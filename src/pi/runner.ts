import {
  AuthStorage,
  createAgentSession,
  type AgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "../config/runtime.ts";
import { logger } from "../logger.ts";

const log = logger.child("pi");

export type ModelInfo = ReturnType<ModelRegistry["getAvailable"]>[number];

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

export type CompactionEvent = {
  type: "compaction_start" | "compaction_end";
  reason: "manual" | "threshold" | "overflow";
  result?: CompactionResult;
  aborted?: boolean;
  errorMessage?: string;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RunOptions = {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (event: ToolEvent) => void | Promise<void>;
};

export type CompactionCallback = (event: CompactionEvent) => void;

export type SessionListItem = {
  id: string;
  name?: string;
  path: string;
  messageCount: number;
  firstMessage: string;
  modified: Date;
};

export type WorkspaceListItem = {
  index: number;
  cwd: string;
  current: boolean;
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
  skillCount: number;
};

export type RuntimeStatus = {
  isStreaming: boolean;
  isCompacting: boolean;
};

/**
 * Workspace: cwd-bound session management.
 * Owns settings, sessions, and agent session for a single working directory.
 * Global resources (auth, model registry) are injected from PiRunner.
 */
class Workspace {
  private session: AgentSession | undefined;
  private settingsManager: SettingsManager | undefined;
  private initPromise: Promise<void> | undefined;
  private compactionCallback: CompactionCallback | undefined;
  private unsubscribeSession: (() => void) | undefined;

  constructor(
    readonly cwd: string,
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
  ) {}

  setCompactionCallback(callback: CompactionCallback): void {
    this.compactionCallback = callback;
  }

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
      cwd: this.cwd,
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
      skillCount: session.resourceLoader.getSkills().skills.length,
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const session = await this.getSession();
    return {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
    };
  }

  async setModel(provider: string, modelIndex: number): Promise<ModelInfo> {
    const session = await this.getSession();
    const allModels = this.modelRegistry.getAvailable().sort(compareModels);
    const providerModels = allModels.filter((m) => m.provider === provider);
    const model = providerModels[modelIndex];
    if (!model) throw new Error(`Unknown model selection: ${provider} #${modelIndex}`);

    await session.setModel(model);
    return model;
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    const session = await this.getSession();
    return session.getAvailableThinkingLevels() as ThinkingLevel[];
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const session = await this.getSession();
    session.setThinkingLevel(level);
    return session.thinkingLevel as ThinkingLevel;
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

  async listSessions(): Promise<SessionListItem[]> {
    const sessions = await SessionManager.list(this.cwd);
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions.slice(0, 5);
  }

  async switchSession(index: number): Promise<SessionListItem> {
    const sessions = await this.listSessions();
    const target = sessions[index];
    if (!target) throw new Error(`Invalid session index: ${index}`);

    this.session?.dispose();
    this.session = undefined;

    const sessionManager = SessionManager.open(target.path, undefined, this.cwd);
    await this.createSession(sessionManager);

    return target;
  }

  async newSession(): Promise<string> {
    this.session?.dispose();
    this.session = undefined;

    const sessionManager = SessionManager.create(this.cwd);
    await this.createSession(sessionManager);

    return this.session!.sessionId;
  }

  dispose(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.settingsManager = undefined;
  }

  private async createSession(sessionManager?: SessionManager): Promise<void> {
    const settingsManager = this.settingsManager ?? SettingsManager.create(this.cwd);

    if (!sessionManager) {
      sessionManager = SessionManager.continueRecent(this.cwd);
    }

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager,
      sessionManager,
    });

    if (modelFallbackMessage) {
      log.warn("model fallback", modelFallbackMessage);
    }

    this.settingsManager = settingsManager;
    this.session = session;

    // Subscribe to compaction events
    this.unsubscribeSession?.();
    this.unsubscribeSession = session.subscribe((event) => {
      if (event.type === "compaction_start") {
        log.info("compaction_start", event);
        this.compactionCallback?.({ type: "compaction_start", reason: event.reason });
      }
      if (event.type === "compaction_end") {
        log.info("compaction_end", event);
        this.compactionCallback?.({
          type: "compaction_end",
          reason: event.reason,
          result: event.result ?? undefined,
          aborted: event.aborted,
          errorMessage: event.errorMessage,
        });
      }
    });

    const skills = session.resourceLoader.getSkills().skills;
    log.info("session initialized", {
      cwd: this.cwd,
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


}

/**
 * PiRunner: global singleton that owns auth and model registry,
 * delegates session work to the current Workspace.
 */
export class PiRunner {
  private authStorage: AuthStorage | undefined;
  private modelRegistry: ModelRegistry | undefined;
  private workspace: Workspace | undefined;
  private currentCwd: string;

  constructor(private readonly config: RuntimeConfig) {
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }

  async init(): Promise<void> {
    await this.getWorkspace().init();
  }

  setCompactionCallback(callback: CompactionCallback): void {
    this.getWorkspace().setCompactionCallback(callback);
  }

  async run(prompt: string, options?: RunOptions): Promise<string> {
    return this.getWorkspace().run(prompt, options);
  }

  async getStatus(): Promise<RunnerStatus> {
    return this.getWorkspace().getStatus();
  }

  async getProviderModels(): Promise<ProviderModels[]> {
    await this.getWorkspace().init();
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
    return this.getWorkspace().setModel(provider, modelIndex);
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    return this.getWorkspace().getAvailableThinkingLevels();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return this.getWorkspace().setThinkingLevel(level);
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return this.getWorkspace().getRuntimeStatus();
  }

  async abort(): Promise<void> {
    return this.getWorkspace().abort();
  }

  async compact(): Promise<void> {
    return this.getWorkspace().compact();
  }

  async listSessions(): Promise<SessionListItem[]> {
    return this.getWorkspace().listSessions();
  }

  listWorkspaces(): WorkspaceListItem[] {
    return this.config.workspaces.map((cwd, index) => ({
      index,
      cwd,
      current: cwd === this.currentCwd,
    }));
  }

  async switchWorkspace(index: number): Promise<WorkspaceListItem> {
    const cwd = this.config.workspaces[index];
    if (!cwd) throw new Error(`Invalid workspace index: ${index}`);

    if (cwd !== this.currentCwd) {
      this.workspace?.dispose();
      this.workspace = undefined;
      this.currentCwd = cwd;
      await this.getWorkspace().init();
    }

    return { index, cwd, current: true };
  }

  async switchSession(index: number): Promise<SessionListItem> {
    return this.getWorkspace().switchSession(index);
  }

  async newSession(): Promise<string> {
    return this.getWorkspace().newSession();
  }

  dispose(): void {
    this.workspace?.dispose();
    this.workspace = undefined;
    this.modelRegistry = undefined;
    this.authStorage = undefined;
    this.currentCwd = this.config.workspaces[0] ?? process.cwd();
  }

  private getWorkspace(): Workspace {
    if (!this.workspace) {
      this.authStorage = this.authStorage ?? AuthStorage.create();
      this.modelRegistry = this.modelRegistry ?? ModelRegistry.create(this.authStorage);

      this.workspace = new Workspace(this.currentCwd, this.authStorage, this.modelRegistry);
    }
    return this.workspace;
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

  if (type === "auto_retry_start" || type === "auto_retry_end" || type === "compaction" || type === "compaction_end") {
    log.info(String(type), typedEvent);
  }
}

function compareModels(a: ModelInfo, b: ModelInfo): number {
  return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
