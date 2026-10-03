import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type InboxState,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import { logger } from "../logger.ts";
import { ConversationOutput } from "./conversation-output.ts";
import { ConversationHistory } from "./history.ts";
import { openWorkspaceHarness } from "./harness.ts";
import { compareModels } from "./models.ts";
import type {
  AdmittedInput,
  ModelInfo,
  OperationCompletion,
  RecentMessage,
  RunnerOutputCallback,
  RunnerStatus,
  RuntimeStatus,
  SessionListItem,
  SubmitOptions,
  ThinkingLevel,
} from "./types.ts";
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

export class DurableWorkspace {
  private harness?: Harness;
  private conversation?: Conversation;
  private output?: ConversationOutput;
  private history?: ConversationHistory;
  private initPromise?: Promise<void>;
  private outputCallback?: RunnerOutputCallback;
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
    if (this.initPromise) return this.initPromise;
    if (this.conversation) return;
    this.initPromise = this.open();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }
  private async open(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    this.harness = await openWorkspaceHarness(
      this.storagePath,
      this.cwd,
      this.models,
    );
    this.history = new ConversationHistory(this.harness);
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
    await this.output?.close();
    this.conversation = conversation;
    const state = await conversation.viewState(context);
    this.output = new ConversationOutput(
      this.requireHarness(),
      state,
      (event) => this.outputCallback?.(event),
    );
    await this.output.flush();
    log.info("conversation ready", {
      cwd: this.cwd,
      sessionId: String(conversation.id),
      storage: this.storagePath,
    });
  }

  async submit(
    prompt: string,
    options: SubmitOptions = {},
  ): Promise<AdmittedInput> {
    await this.init();
    const submission = await this.requireConversation().submit(
      { type: "input", content: prompt, ...options },
      context,
    );
    const output = this.output!;
    const inbox = output.docs["pi.inbox"] as InboxState | undefined;
    return {
      id: submission.id,
      queued: inbox?.items.some((item) => item.id === submission.id) ?? false,
      wait: async () => {
        const result = await submission.wait(context);
        await output.flush();
        if (result.status === "unanswered" && result.reason !== "aborted") {
          throw new Error(
            typeof result.detail === "string"
              ? result.detail
              : `Durable submission ${result.id} was not answered: ${result.reason}`,
          );
        }
      },
    };
  }
  async getRuntimeStatus(): Promise<RuntimeStatus> {
    await this.init();
    const live = this.output!.docs["pi.live"] as LiveState | undefined;
    const inbox = this.output!.docs["pi.inbox"] as InboxState | undefined;
    return {
      isRunning: !!live?.run,
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
    const summary = await this.history!.summary(this.requireConversation());
    const usage = this.output!.docs["pi.usage"] as UsageState | undefined;
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
        ...summary.stats,
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
    return this.history!.recent(this.requireConversation(), limit);
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
    await this.init();
    const agent = await this.requireConversation().agent(context);
    const model = agent.model
      ? this.models.getModel(agent.model.provider, agent.model.modelId)
      : undefined;
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
  async abort(): Promise<OperationCompletion> {
    await this.init();
    const output = this.output!;
    await this.requireConversation().abort(context, { background: true });
    return { wait: () => output.flush() };
  }
  async startCompaction(): Promise<OperationCompletion> {
    await this.init();
    await this.requireIdle();
    const harness = this.requireHarness();
    const output = this.output!;
    const id = await this.requireConversation().compact(undefined, context);
    return {
      wait: async () => {
        const task = await harness.waitForTask(id, context);
        const outcome = task.state.outcome;
        if (
          outcome.status === "completed" &&
          outcome.result.submissionId !== undefined
        )
          await (
            await harness.submission(outcome.result.submissionId, context)
          )?.wait(context);
        await output.flush();
      },
    };
  }
  async listSessions(): Promise<SessionListItem[]> {
    await this.init();
    const state = await this.requireHarness().snapshot(PilotSessions, context);
    const candidates = [];
    for (const saved of state?.sessions ?? []) {
      const conversation = await this.requireHarness().conversation(
        saved.id as ConversationId,
        context,
      );
      if (!conversation) continue;
      candidates.push({
        saved,
        conversation,
        modified: await this.history!.latestActivity(
          conversation,
          saved.created,
        ),
      });
    }
    candidates.sort(
      (a, b) => b.modified - a.modified || b.saved.id - a.saved.id,
    );
    return Promise.all(
      candidates.slice(0, 5).map(async ({ saved, conversation, modified }) => {
        const summary = await this.history!.summary(conversation);
        return {
          id: String(saved.id),
          path: this.storagePath,
          messageCount: summary.stats.totalMessages,
          firstMessage: summary.firstMessage,
          modified: new Date(modified),
        };
      }),
    );
  }
  async switchSession(index: number): Promise<SessionListItem> {
    await this.requireIdle();
    const target = (await this.listSessions())[index];
    if (!target) throw new Error(`Invalid session index: ${index}`);
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
    if (status.isRunning || status.isCompacting || status.pendingMessages)
      throw new Error(
        "Durable workspace is busy; stop it before switching or reloading.",
      );
    await this.output?.flush();
  }
  async dispose(): Promise<void> {
    // Close checkpoints unfinished work instead of aborting it; reopen resumes it.
    await this.harness?.close(context);
    await this.output?.close();
    this.history?.dispose();
    this.output = undefined;
    this.history = undefined;
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
