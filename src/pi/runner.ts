import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  section,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { RuntimeConfig } from "../config/runtime.ts";
import { logger } from "../logger.ts";
import type { RunnerEvent } from "./events.ts";

const context = BACKGROUND_CONTEXT;
const log = logger.child("durable");
const PilotSessions = defineDoc<{
  current?: number;
  sessions: { id: number; created: number }[];
}>({
  kind: "pilot.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: [] }),
});

export type ModelInfo = Model<Api>;
export type ProviderModels = {
  provider: string;
  displayName: string;
  models: ModelInfo[];
};
export type ToolEvent = {
  toolName?: unknown;
  toolCallId?: unknown;
  args?: unknown;
};
export type ThinkingLevel = ModelThinkingLevel;
export type RunnerOutputCallback = (event: RunnerEvent) => void | Promise<void>;
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
export type RuntimeStatus = {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessages: number;
};
export type RunnerStatus = RuntimeStatus & {
  cwd: string;
  sessionId: string;
  model?: ModelInfo;
  thinkingLevel: string;
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
  extensionCount: number;
};
export type RecentMessage = {
  role: "User" | "Assistant" | "Summary";
  text: string;
};
export type PiRunnerOptions = { models?: Models; dataDir?: string };

class Workspace {
  private harness?: Harness;
  private conversation?: Conversation;
  private view?: AttachedReplicatedState<ConversationView>;
  private events?: AgentEventStream;
  private initPromise?: Promise<void>;
  private outputCallback?: RunnerOutputCallback;
  private textBlocks = new Map<number, string>();
  private emittedText = "";
  private lastAssistant?: AssistantMessage;
  private outputDelivery = Promise.resolve();
  private barriers = new Map<string, () => void>();
  readonly storagePath: string;

  constructor(
    readonly cwd: string,
    private readonly models: Models,
    dataDir: string,
    private readonly preferredModel?: string,
  ) {
    const key = createHash("sha256")
      .update(process.platform === "win32" ? cwd.toLowerCase() : cwd)
      .digest("hex")
      .slice(0, 24);
    this.storagePath = join(dataDir, "workspaces", key);
  }
  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
  }
  async init(): Promise<void> {
    if (this.conversation) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.open();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }
  private async open(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(
      defineExtension({
        name: "pilot",
        sections: [
          section(
            "preamble",
            () =>
              "You are Pi Pilot, a coding assistant accessed through Telegram. Use the tools to inspect and modify the workspace, verify your work, and give concise replies. Attached files are supplied as local paths.",
            { tag: false },
          ),
          section("cwd", (input) => input.env?.cwd),
        ],
      }),
    );
    const storage = await openNodeJsonlStorage(this.storagePath, context, {
      fsync: true,
    });
    this.harness = await Harness.open(
      storage,
      {
        models: this.models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.cwd }),
        settings: { toolExecution: "sequential", steeringMode: "all" },
        onReport: (error) => log.error("harness report", error),
      },
      context,
    );
    try {
      const state = await this.harness.snapshot(PilotSessions, context);
      const saved = state?.sessions.find(
        (session) => session.id === state.current,
      );
      const conversation = saved
        ? await this.harness.conversation(saved.id as ConversationId, context)
        : undefined;
      await this.bind(conversation ?? (await this.createConversation()));
      // Attach output before starting recovery of interrupted tasks.
      this.harness.resume();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  private async createConversation(): Promise<Conversation> {
    const previous = await this.conversation?.agent(context);
    const model = previous?.model ?? (await this.selectInitialModel());
    return this.requireHarness().createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          cwd: this.cwd,
          ...(model ? { model } : {}),
          thinkingLevel: previous?.thinkingLevel ?? "off",
        },
        init: async (tx, id) => {
          const state = await tx.doc(PilotSessions);
          state.current = id;
          state.sessions.push({ id, created: Date.now() });
        },
      },
      context,
    );
  }
  private async selectInitialModel() {
    const available = [...(await this.models.getAvailable())].sort(
      compareModels,
    );
    if (this.preferredModel) {
      const separator = this.preferredModel.indexOf("/");
      const provider = this.preferredModel.slice(0, separator);
      const modelId = this.preferredModel.slice(separator + 1);
      const selected = available.find(
        (model) => model.provider === provider && model.id === modelId,
      );
      if (separator < 1 || !selected)
        throw new Error(
          `PI_PILOT_MODEL is unavailable: ${this.preferredModel}. Configure its provider credentials.`,
        );
      return { provider, modelId };
    }
    const selected = available[0];
    return selected
      ? { provider: selected.provider, modelId: selected.id }
      : undefined;
  }
  private async bind(conversation: Conversation): Promise<void> {
    await this.events?.stop();
    await this.outputDelivery;
    this.view?.dispose();
    this.conversation = conversation;
    this.view = await conversation.viewState(context);
    this.events = await watchEvents(
      this.requireHarness(),
      conversation.id,
      context,
    );
    this.resetText();
    this.lastAssistant = undefined;
    this.handleSnapshot(this.events.snapshot);
    this.events.start(async (events) => {
      for (const event of events) await this.handleEvent(event);
    });
    log.info("conversation ready", {
      cwd: this.cwd,
      sessionId: String(conversation.id),
      storage: this.storagePath,
    });
  }
  private emit(event: RunnerEvent): void {
    this.outputDelivery = this.outputDelivery
      .then(() => this.outputCallback?.(event))
      .catch((error) => log.error("output delivery failed", error));
  }
  private resetText(): void {
    this.textBlocks.clear();
    this.emittedText = "";
  }
  private updateText(message: AssistantMessage): void {
    this.textBlocks.clear();
    message.content.forEach((block, index) => {
      if (block.type === "text") this.textBlocks.set(index, block.text);
    });
    this.flushText();
  }
  private flushText(): void {
    const text = [...this.textBlocks]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join("");
    if (!text.startsWith(this.emittedText)) {
      this.emit({ type: "segment_break" });
      this.emittedText = "";
    }
    const delta = text.slice(this.emittedText.length);
    if (delta)
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      });
    this.emittedText = text;
  }
  private handleSnapshot(
    event: Extract<AgentEvent, { type: "snapshot" }>,
  ): void {
    // Late attachments publish only live output, never replay the old transcript.
    if (event.run) {
      this.emit({ type: "agent_start" });
      if (event.generation?.message) this.updateText(event.generation.message);
    }
    this.emitInbox(event.inbox);
  }
  private emitInbox(items: readonly { id: number; mode: string }[]): void {
    this.emit({
      type: "queue_update",
      steering: items
        .filter((item) => item.mode === "steer")
        .map((item) => item.id),
      followUp: items
        .filter((item) => item.mode === "followUp")
        .map((item) => item.id),
    });
  }
  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "snapshot":
        this.emit({ type: "segment_break" });
        this.resetText();
        this.handleSnapshot(event);
        break;
      case "run_start":
        this.resetText();
        this.lastAssistant = undefined;
        this.emit({ type: "agent_start" });
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.resetText();
          this.updateText(event.message);
        }
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "message") this.updateText(change.message);
          else if (change.type === "text_delta")
            this.textBlocks.set(
              change.contentIndex,
              (this.textBlocks.get(change.contentIndex) ?? "") + change.delta,
            );
          else if (
            (change.type === "text_start" || change.type === "block") &&
            change.block.type === "text"
          )
            this.textBlocks.set(change.contentIndex, change.block.text);
        }
        this.flushText();
        break;
      case "message_end": {
        const message = event.entry.model?.[0];
        if (message?.role === "assistant") {
          this.updateText(message);
          this.lastAssistant = message;
        }
        break;
      }
      case "tool_execution_start":
        this.emit(event);
        break;
      case "inbox_update":
        this.emitInbox(event.items);
        break;
      case "submission":
        if (
          event.record.type === "input" &&
          event.record.status === "unanswered" &&
          event.record.reason !== "aborted"
        ) {
          this.emit({
            type: "submission_failed",
            message:
              typeof event.record.detail === "string"
                ? event.record.detail
                : event.record.reason,
          });
        }
        break;
      case "run_end":
        this.emit({
          type: "agent_end",
          messages: this.lastAssistant ? [this.lastAssistant] : [],
        });
        this.emit({ type: "agent_settled" });
        break;
      case "compaction_start":
        this.emit({ type: "compaction_start", reason: event.reason });
        break;
      case "compaction_end": {
        const task = await this.requireHarness().getTask(event.taskId, context);
        const outcome =
          task?.state.status === "terminal" ? task.state.outcome : undefined;
        const result =
          outcome?.status === "completed"
            ? (outcome.result as { entryId?: number; submissionId?: number })
            : undefined;
        this.emit({
          type: "compaction_end",
          aborted: outcome?.status === "aborted",
          errorMessage:
            outcome &&
            (outcome.status === "failed" || outcome.status === "faulted")
              ? outcome.error.message
              : undefined,
          skipped:
            outcome?.status === "completed" &&
            result?.entryId === undefined &&
            result?.submissionId === undefined,
        });
        break;
      }
      case "auto_retry_start":
        this.emit({ type: "segment_break" });
        this.resetText();
        break;
      case "entry_appended":
        if (event.entry.kind === "pilot.delivery") {
          const id = (event.entry.data as { id: string }).id;
          await this.outputDelivery;
          this.barriers.get(id)?.();
          this.barriers.delete(id);
        }
        break;
    }
  }
  async run(
    prompt: string,
    options: { streamingBehavior?: "steer"; requestId?: string } = {},
  ): Promise<void> {
    await this.init();
    const submission = await this.requireConversation().submit(
      {
        type: "input",
        content: prompt,
        whenBusy: options.streamingBehavior === "steer" ? "steer" : "followUp",
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
      context,
    );
    // Steering resolves at durable admission, so Telegram remains responsive.
    if (options.streamingBehavior === "steer") return;
    const result = await submission.wait(context);
    await this.flushEvents();
    if (result.status === "unanswered" && result.reason !== "aborted")
      throw new Error(
        typeof result.detail === "string"
          ? result.detail
          : `Durable submission ${result.id} was not answered: ${result.reason}`,
      );
  }
  private async flushEvents(): Promise<void> {
    // A passive committed entry marks the end of this event batch. The watcher
    // resolves it only after earlier output (including run_end) has been delivered.
    const id = randomUUID();
    const delivered = new Promise<void>((resolve) =>
      this.barriers.set(id, resolve),
    );
    try {
      await this.requireConversation().submit(
        { type: "write", entry: { kind: "pilot.delivery", data: { id } } },
        context,
      );
      await delivered;
    } finally {
      this.barriers.delete(id);
    }
  }
  async getRuntimeStatus(): Promise<RuntimeStatus> {
    await this.init();
    const live = this.view!.value.docs["pi.live"] as LiveState | undefined;
    const inbox = this.view!.value.docs["pi.inbox"] as InboxState | undefined;
    return {
      isStreaming: !!live?.run,
      isCompacting: !!live?.compactions?.length,
      pendingMessages: inbox?.items.length ?? 0,
    };
  }
  async getStatus(): Promise<RunnerStatus> {
    await this.init();
    const agent = await this.requireConversation().agent(context);
    const model = agent.model
      ? this.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined;
    const entries = await this.allEntries(this.requireConversation());
    const messages = entries.flatMap((entry) => entry.model ?? []);
    const assistants = messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    const usage = this.view!.value.docs["pi.usage"] as UsageState | undefined;
    return {
      ...(await this.getRuntimeStatus()),
      cwd: this.cwd,
      sessionId: String(this.requireConversation().id),
      model,
      thinkingLevel: model
        ? clampThinkingLevel(model, agent.thinkingLevel)
        : agent.thinkingLevel,
      context: model
        ? { tokens: null, contextWindow: model.contextWindow, percent: null }
        : undefined,
      stats: {
        userMessages: messages.filter((m) => m.role === "user").length,
        assistantMessages: assistants.length,
        toolCalls: assistants.reduce(
          (sum, m) =>
            sum + m.content.filter((c) => c.type === "toolCall").length,
          0,
        ),
        toolResults: messages.filter((m) => m.role === "toolResult").length,
        totalMessages: messages.filter((m) => m.role !== "system").length,
        cost: Object.values(usage?.models ?? {})
          .concat(Object.values(usage?.tools ?? {}))
          .reduce((sum, usage) => sum + usage.cost.total, 0),
      },
      activeTools: agent.tools.map((tool) => tool.name),
      extensionCount: agent.extensions.length,
    };
  }
  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    await this.init();
    return (await this.allEntries(this.requireConversation()))
      .map(toRecentMessage)
      .filter((m): m is RecentMessage => !!m?.text.trim())
      .slice(-limit);
  }
  async setModel(provider: string, modelIndex: number): Promise<ModelInfo> {
    await this.init();
    const model = [...(await this.models.getAvailable(provider))].sort(
      compareModels,
    )[modelIndex];
    if (!model)
      throw new Error(`Unknown model selection: ${provider} #${modelIndex}`);
    const agent = await this.requireConversation().agent(context);
    await this.requireConversation().configure(
      {
        model: { provider, modelId: model.id },
        thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel),
      },
      context,
    );
    return model;
  }
  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    const { model } = await this.getStatus();
    return model ? getSupportedThinkingLevels(model) : ["off"];
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const available = await this.getAvailableThinkingLevels();
    if (!available.includes(level))
      throw new Error(`Unsupported thinking level: ${level}`);
    await this.requireConversation().configure(
      { thinkingLevel: level },
      context,
    );
    return level;
  }
  async abort(): Promise<void> {
    await this.init();
    await this.requireConversation().abort(context, { background: true });
    await this.flushEvents();
  }
  async compact(): Promise<void> {
    await this.init();
    const id = await this.requireConversation().compact(undefined, context);
    const task = await this.requireHarness().waitForTask(id, context);
    const outcome = task.state.outcome;
    if (
      outcome.status === "completed" &&
      outcome.result.submissionId !== undefined
    )
      await (
        await this.requireHarness().submission(
          outcome.result.submissionId,
          context,
        )
      )?.wait(context);
    await this.flushEvents();
  }
  async listSessions(): Promise<SessionListItem[]> {
    await this.init();
    const state = await this.requireHarness().snapshot(PilotSessions, context);
    const sessions: SessionListItem[] = [];
    for (const saved of state?.sessions ?? []) {
      const conversation = await this.requireHarness().conversation(
        saved.id as ConversationId,
        context,
      );
      if (!conversation) continue;
      const messages = (await this.allEntries(conversation)).flatMap(
        (entry) => entry.model ?? [],
      );
      sessions.push({
        id: String(saved.id),
        path: this.storagePath,
        messageCount: messages.filter((m) => m.role !== "system").length,
        firstMessage: contentToText(
          messages.find((m) => m.role === "user")?.content,
        ),
        modified: new Date(
          Math.max(saved.created, ...messages.map((m) => m.timestamp)),
        ),
      });
    }
    return sessions
      .sort(
        (a, b) =>
          b.modified.getTime() - a.modified.getTime() ||
          Number(b.id) - Number(a.id),
      )
      .slice(0, 5);
  }
  async switchSession(index: number): Promise<SessionListItem> {
    const target = (await this.listSessions())[index];
    if (!target) throw new Error(`Invalid session index: ${index}`);
    await this.requireIdle();
    const conversation = await this.requireHarness().conversation(
      Number(target.id) as ConversationId,
      context,
    );
    if (!conversation) throw new Error("Session no longer exists");
    await this.requireHarness().commit(async (tx) => {
      (await tx.doc(PilotSessions)).current = conversation.id;
    }, context);
    await this.bind(conversation);
    return target;
  }
  async newSession(): Promise<string> {
    await this.init();
    await this.requireIdle();
    await this.bind(await this.createConversation());
    return String(this.requireConversation().id);
  }
  async requireIdle(): Promise<void> {
    const status = await this.getRuntimeStatus();
    if (status.isStreaming || status.isCompacting || status.pendingMessages)
      throw new Error(
        "Durable workspace is busy; stop it before switching or reloading.",
      );
  }
  private async allEntries(conversation: Conversation): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 250, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return entries.reverse();
  }
  async dispose(): Promise<void> {
    // Close checkpoints unfinished work instead of aborting it; reopen resumes it.
    await this.harness?.close(context);
    await this.events?.stop();
    await this.outputDelivery;
    this.view?.dispose();
    for (const resolve of this.barriers.values()) resolve();
    this.barriers.clear();
    this.events = undefined;
    this.view = undefined;
    this.conversation = undefined;
    this.harness = undefined;
  }
  private requireHarness(): Harness {
    if (!this.harness) throw new Error("Durable harness is not initialized");
    return this.harness;
  }
  private requireConversation(): Conversation {
    if (!this.conversation)
      throw new Error("Durable conversation is not initialized");
    return this.conversation;
  }
}

export class PiRunner {
  private readonly models: Models;
  private readonly dataDir: string;
  private workspace?: Workspace;
  private currentCwd: string;
  private outputCallback?: RunnerOutputCallback;
  constructor(
    private readonly config: RuntimeConfig,
    options: PiRunnerOptions = {},
  ) {
    this.models = options.models ?? builtinModels();
    this.dataDir = resolve(
      options.dataDir ??
        config.dataDir ??
        join(homedir(), ".pi", "pilot", "durable"),
    );
    this.currentCwd = config.workspaces[0] ?? process.cwd();
  }
  private async getWorkspace(): Promise<Workspace> {
    if (!this.workspace) {
      this.workspace = new Workspace(
        this.currentCwd,
        this.models,
        this.dataDir,
        this.config.model,
      );
      if (this.outputCallback)
        this.workspace.setOutputCallback(this.outputCallback);
    }
    await this.workspace.init();
    return this.workspace;
  }
  async init(): Promise<void> {
    await this.getWorkspace();
  }
  setOutputCallback(callback: RunnerOutputCallback): void {
    this.outputCallback = callback;
    this.workspace?.setOutputCallback(callback);
  }
  async run(
    prompt: string,
    options: { streamingBehavior?: "steer"; requestId?: string } = {},
  ): Promise<void> {
    await (await this.getWorkspace()).run(prompt, options);
  }
  async getStatus(): Promise<RunnerStatus> {
    return (await this.getWorkspace()).getStatus();
  }
  async getRuntimeStatus(): Promise<RuntimeStatus> {
    return (await this.getWorkspace()).getRuntimeStatus();
  }
  async getRecentMessages(limit = 6): Promise<RecentMessage[]> {
    return (await this.getWorkspace()).getRecentMessages(limit);
  }
  async getProviderModels(): Promise<ProviderModels[]> {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of [...(await this.models.getAvailable())].sort(
      compareModels,
    )) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups].map(([provider, models]) => ({
      provider,
      displayName: this.models.getProvider(provider)?.name ?? provider,
      models,
    }));
  }
  async setModel(provider: string, index: number): Promise<ModelInfo> {
    return (await this.getWorkspace()).setModel(provider, index);
  }
  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    return (await this.getWorkspace()).getAvailableThinkingLevels();
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return (await this.getWorkspace()).setThinkingLevel(level);
  }
  async abort(): Promise<void> {
    await (await this.getWorkspace()).abort();
  }
  async compact(): Promise<void> {
    await (await this.getWorkspace()).compact();
  }
  async listSessions(): Promise<SessionListItem[]> {
    return (await this.getWorkspace()).listSessions();
  }
  async switchSession(index: number): Promise<SessionListItem> {
    return (await this.getWorkspace()).switchSession(index);
  }
  async newSession(): Promise<string> {
    return (await this.getWorkspace()).newSession();
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
      await this.workspace?.requireIdle();
      await this.workspace?.dispose();
      this.workspace = undefined;
      this.currentCwd = cwd;
      await this.getWorkspace();
    }
    return { index, cwd, current: true };
  }
  async reload(): Promise<void> {
    await this.workspace?.requireIdle();
    await this.workspace?.dispose();
    this.workspace = undefined;
    await this.getWorkspace();
  }
  async dispose(): Promise<void> {
    await this.workspace?.dispose();
    this.workspace = undefined;
  }
}
function compareModels(a: ModelInfo, b: ModelInfo): number {
  return (
    a.provider.localeCompare(b.provider) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}
function toRecentMessage(entry: EntryRecord): RecentMessage | undefined {
  const message = entry.model?.[0];
  if (!message) return undefined;
  if (entry.kind === "pi.compaction")
    return { role: "Summary", text: contentToText(message.content) };
  if (message.role === "user")
    return { role: "User", text: contentToText(message.content) };
  if (message.role === "assistant")
    return { role: "Assistant", text: contentToText(message.content) };
  return undefined;
}
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part?.type === "text"
        ? part.text
        : part?.type === "image"
          ? "[image]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}
