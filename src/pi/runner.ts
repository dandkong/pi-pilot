import { rm } from "node:fs/promises";
import {
  type AgentSession,
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "../config/runtime.ts";
import { logger } from "../logger.ts";

const log = logger.child("pi");

export type ModelInfo = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

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

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunnerOutputCallback = (event: AgentSessionEvent) => void;

export type SessionListItem = {
  id: string;
  name?: string;
  path: string;
  messageCount: number;
  firstMessage: string;
  modified: Date;
};

export type DeleteSessionResult =
  | { ok: true; session: SessionListItem }
  | { ok: false; reason: string };

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
 * Global model/auth runtime is injected from PiRunner.
 */
class Workspace {
  private runtime: AgentSessionRuntime | undefined;
  private initPromise: Promise<void> | undefined;
  private outputCallback: RunnerOutputCallback | undefined;
  private unsubscribeSession: (() => void) | undefined;

  constructor(
    readonly cwd: string,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
  }

  async init(): Promise<void> {
    if (this.runtime) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.createInitialRuntime();
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
    const allModels = [...(await this.modelRuntime.getAvailable())].sort(compareModels);
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

    // Official replacement API: emits session_before_switch/session_shutdown
    // extension hooks, rebuilds cwd-bound services, and rebinds via setRebindSession().
    await this.replaceSession((runtime) => runtime.switchSession(target.path, { cwdOverride: this.cwd }));

    return target;
  }

  async newSession(): Promise<string> {
    await this.replaceSession((runtime) => runtime.newSession());
    return this.requireRuntime().session.sessionId;
  }

  async deleteSession(id: string): Promise<DeleteSessionResult> {
    const sessions = await this.listSessions();
    const target = sessions.find((session) => session.id === id);
    if (!target) return { ok: false, reason: "Session not found or already deleted" };

    await rm(target.path, { force: true });
    return { ok: true, session: target };
  }

  async dispose(): Promise<void> {
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    await this.runtime?.dispose();
    this.runtime = undefined;
  }

  /**
   * Create the initial AgentSessionRuntime for this workspace cwd.
   * The runtime owns session replacement (new/resume) and re-runs the factory
   * below for each replacement, so replaced sessions get fresh cwd-bound services.
   */
  private async createInitialRuntime(): Promise<void> {
    const sessionManager = SessionManager.continueRecent(this.cwd);
    const runtime = await createAgentSessionRuntime(this.createRuntimeFactory(), {
      cwd: this.cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    this.runtime = runtime;

    // Official hook: called by AgentSessionRuntime after every session replacement.
    runtime.setRebindSession((session) => this.rebindSession(session));
    await this.rebindSession(runtime.session);
    this.logDiagnostics(runtime);
  }

  private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: createTrustedSettingsManager(cwd),
        modelRuntime: this.modelRuntime,
      });
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };
  }

  private async replaceSession(
    action: (runtime: AgentSessionRuntime) => Promise<{ cancelled: boolean }>,
  ): Promise<void> {
    const result = await action(this.requireRuntime());
    if (result.cancelled) {
      throw new Error("Session switch was cancelled by an extension");
    }
    this.logDiagnostics(this.requireRuntime());
  }

  /**
   * Attach host-level notifications to a (possibly replaced) session:
   * bind extensions and subscribe to events. SDK session creation does not
   * emit extension session_start by itself, so bind explicitly for the
   * session_start/resources_discover lifecycle hooks.
   */
  private async rebindSession(session: AgentSession): Promise<void> {
    await session.bindExtensions({});

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

  private logDiagnostics(runtime: AgentSessionRuntime): void {
    for (const diagnostic of runtime.diagnostics) {
      if (diagnostic.type === "warning" || diagnostic.type === "error") {
        log.warn(`session runtime diagnostic [${diagnostic.type}]`, { message: diagnostic.message });
      }
    }
    if (runtime.modelFallbackMessage) {
      log.warn("session model fallback", { message: runtime.modelFallbackMessage });
    }
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Pi session was not initialized");
    return this.runtime;
  }

  private async getSession(): Promise<AgentSession> {
    await this.init();
    return this.requireRuntime().session;
  }


}

/**
 * PiRunner: global singleton that owns the model/auth runtime,
 * delegates session work to the current Workspace.
 */
export class PiRunner {
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private workspace: Workspace | undefined;
  private currentCwd: string;
  private outputCallback: RunnerOutputCallback | undefined;

  constructor(private readonly config: RuntimeConfig) {
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }

  async init(): Promise<void> {
    const workspace = await this.getWorkspace();
    await workspace.init();
  }

  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
    this.workspace?.setOutputCallback(callback);
  }

  async run(prompt: string): Promise<void> {
    return (await this.getWorkspace()).run(prompt);
  }

  async getStatus(): Promise<RunnerStatus> {
    return (await this.getWorkspace()).getStatus();
  }

  async getProviderModels(): Promise<ProviderModels[]> {
    const workspace = await this.getWorkspace();
    await workspace.init();
    const runtime = await this.getModelRuntime();
    const models = [...(await runtime.getAvailable())].sort(compareModels);
    const groups = new Map<string, ModelInfo[]>();

    for (const model of models) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }

    return [...groups.entries()].map(([provider, providerModels]) => ({
      provider,
      displayName: runtime.getProvider(provider)?.name ?? provider,
      models: providerModels,
    }));
  }

  async setModel(provider: string, modelIndex: number): Promise<ModelInfo> {
    return (await this.getWorkspace()).setModel(provider, modelIndex);
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    return (await this.getWorkspace()).getAvailableThinkingLevels();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return (await this.getWorkspace()).setThinkingLevel(level);
  }

  async reload(): Promise<void> {
    await this.workspace?.dispose();
    this.workspace = undefined;
    await (await this.getWorkspace()).init();
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return (await this.getWorkspace()).getRuntimeStatus();
  }

  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    return (await this.getWorkspace()).getRecentMessages(limit);
  }

  async abort(): Promise<void> {
    return (await this.getWorkspace()).abort();
  }

  async compact(): Promise<void> {
    return (await this.getWorkspace()).compact();
  }

  async listSessions(): Promise<SessionListItem[]> {
    return (await this.getWorkspace()).listSessions();
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
      await this.workspace?.dispose();
      this.workspace = undefined;
      this.currentCwd = cwd;
      await (await this.getWorkspace()).init();
    }

    return { index, cwd, current: true };
  }

  async switchSession(index: number): Promise<SessionListItem> {
    return (await this.getWorkspace()).switchSession(index);
  }

  async newSession(): Promise<string> {
    return (await this.getWorkspace()).newSession();
  }

  async deleteSession(id: string): Promise<DeleteSessionResult> {
    return (await this.getWorkspace()).deleteSession(id);
  }

  async dispose(): Promise<void> {
    await this.workspace?.dispose();
    this.workspace = undefined;
    this.modelRuntimePromise = undefined;
    this.currentCwd = this.config.workspaces[0] ?? process.cwd();
  }

  private async getWorkspace(): Promise<Workspace> {
    if (!this.workspace) {
      const modelRuntime = await this.getModelRuntime();
      if (!this.workspace) {
        this.workspace = new Workspace(this.currentCwd, modelRuntime);
        if (this.outputCallback) this.workspace.setOutputCallback(this.outputCallback);
      }
    }
    return this.workspace;
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = ModelRuntime.create();
    }
    return this.modelRuntimePromise;
  }
}

function createTrustedSettingsManager(cwd: string): SettingsManager {
  // Pi Pilot is a remote SDK UI for user-configured workspaces. Treat them as
  // trusted so project-local .pi settings/resources load without a TUI prompt.
  return SettingsManager.create(cwd, undefined, { projectTrusted: true });
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
