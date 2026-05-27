import {
  AuthStorage,
  createAgentSession,
  type AgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RunnerOutputCallback = (event: AgentSessionEvent) => void;

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
  pendingMessages: number;
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
  extensionCount: number;
};

export type RuntimeStatus = {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessages: number;
};

export type RecentMessage = {
  role: "User" | "Assistant" | "Summary";
  text: string;
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
  private outputCallback: RunnerOutputCallback | undefined;
  private unsubscribeSession: (() => void) | undefined;

  constructor(
    readonly cwd: string,
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
  ) {}

  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
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

  async run(prompt: string): Promise<void> {
    const session = await this.getSession();
    await session.prompt(prompt, { source: "rpc" });
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
      pendingMessages: session.pendingMessageCount,
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
      extensionCount: session.resourceLoader.getExtensions().extensions.length,
    };
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const session = await this.getSession();
    return {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessages: session.pendingMessageCount,
    };
  }

  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    const session = await this.getSession();
    return session.messages
      .map(toRecentMessage)
      .filter((message): message is RecentMessage => !!message && !!message.text.trim())
      .slice(-limit);
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

    const { session } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager,
      sessionManager,
    });

    this.settingsManager = settingsManager;
    this.session = session;

    // SDK direct createAgentSession() does not emit extension session_start by itself.
    // Bind extensions explicitly so session_start/resources_discover lifecycle hooks run.
    await session.bindExtensions({});

    // Subscribe once for host-level notifications that are not tied to a run callback.
    this.unsubscribeSession?.();
    this.unsubscribeSession = session.subscribe((event) => {
      this.outputCallback?.(event);

      logAgentEvent(event);
    });

    const skills = session.resourceLoader.getSkills().skills;
    const extensions = session.resourceLoader.getExtensions().extensions;
    log.info("session initialized", {
      cwd: this.cwd,
      sessionId: session.sessionId,
      model: session.model ? `${session.model.provider}/${session.model.name}` : undefined,
      thinkingLevel: session.thinkingLevel,
      activeTools: formatList(session.getActiveToolNames()),
      extensions: formatList(extensions.map((extension) => extension.path)),
      skills: formatList(skills.map((skill) => skill.name)),
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
  private outputCallback: RunnerOutputCallback | undefined;

  constructor(private readonly config: RuntimeConfig) {
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }

  async init(): Promise<void> {
    await this.getWorkspace().init();
  }

  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
    this.getWorkspace().setOutputCallback(callback);
  }

  async run(prompt: string): Promise<void> {
    return this.getWorkspace().run(prompt);
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

  async reload(): Promise<void> {
    this.workspace?.dispose();
    this.workspace = undefined;
    await this.getWorkspace().init();
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return this.getWorkspace().getRuntimeStatus();
  }

  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    return this.getWorkspace().getRecentMessages(limit);
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
      if (this.outputCallback) this.workspace.setOutputCallback(this.outputCallback);
    }
    return this.workspace;
  }

  private getModelRegistry(): ModelRegistry {
    if (!this.modelRegistry) throw new Error("Pi model registry was not initialized");
    return this.modelRegistry;
  }
}

function formatList(items: string[]): string {
  return items.length ? items.join(", ") : "(none)";
}

function toRecentMessage(message: unknown): RecentMessage | undefined {
  if (!message || typeof message !== "object" || !("role" in message)) return undefined;
  const record = message as Record<string, unknown>;
  const role = record.role;

  if (role === "user") {
    return { role: "User", text: contentToText(record.content) };
  }

  if (role === "assistant") {
    return { role: "Assistant", text: contentToText(record.content) };
  }

  if (role === "compactionSummary") {
    return { role: "Summary", text: stringValue(record.summary) };
  }

  if (role === "branchSummary") {
    return { role: "Summary", text: stringValue(record.summary) };
  }

  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text") return stringValue(record.text);
      if (record.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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
