import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  CommitPublication,
  ConversationView,
  EntryRecord,
  Harness,
  LiveState,
  ToolSlot,
} from "@earendil-works/pi-durable";
import { logger } from "../logger.ts";
import type { RunnerEvent } from "./events.ts";
import type { RunnerOutputCallback } from "./types.ts";
import { contentToText } from "./history.ts";

const log = logger.child("durable-output");

/** Projects already committed state. It never submits work or writes UI markers. */
export class ConversationProjection {
  private previous: ConversationView;
  private partialId?: string;
  private lastAssistant?: AssistantMessage;

  constructor(view: ConversationView) {
    this.previous = view;
  }

  attach(): RunnerEvent[] {
    const live = liveState(this.previous);
    const events: RunnerEvent[] = [{ type: "conversation_attached" }];
    if (live.run) events.push({ type: "run_started", id: live.run.inputs[0]! });
    if (live.generation?.message && live.run) {
      this.partialId = generationId(live);
      events.push({
        type: "assistant_text",
        messageId: this.partialId,
        text: contentToText(live.generation.message.content),
      });
    }
    for (const slot of live.tools ?? []) {
      if (slot.status === "running")
        events.push(toolStart(slot, this.previous.entries));
    }
    for (const task of live.compactions ?? [])
      events.push({ type: "compaction_start", reason: task.reason });
    return events;
  }

  accept(
    publication: CommitPublication,
    view: ConversationView,
  ): RunnerEvent[] {
    const id = view.conversation.id;
    const before = liveState(this.previous);
    const after = liveState(view);
    const oldRun = before.run?.inputs[0];
    const newRun = after.run?.inputs[0];
    const events: RunnerEvent[] = [];
    if (oldRun === undefined && newRun !== undefined) {
      this.lastAssistant = undefined;
      this.partialId = undefined;
      events.push({ type: "run_started", id: newRun });
    }
    let firstInput = oldRun === undefined && newRun !== undefined;
    const entries = publication.changes
      .filter(
        (change) =>
          change.type === "entry" && change.value.conversationId === id,
      )
      .map(
        (change) => (change as Extract<typeof change, { type: "entry" }>).value,
      )
      .sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.user") {
        if (!firstInput) events.push({ type: "segment_break" });
        firstInput = false;
      }
      if (message?.role === "assistant") {
        events.push({
          type: "assistant_text",
          messageId: this.partialId ?? `entry:${entry.id}`,
          text: contentToText(message.content),
        });
        this.lastAssistant = message;
        this.partialId = undefined;
      }
    }
    for (const slot of after.tools ?? []) {
      if (
        slot.status !== "running" ||
        before.tools?.some(
          (old) => old.callId === slot.callId && old.status === "running",
        )
      )
        continue;
      events.push(toolStart(slot, view.entries, publication));
    }
    if (oldRun !== undefined && oldRun !== newRun) {
      events.push({
        type: "run_finished",
        id: oldRun,
        emptyAnswer:
          this.lastAssistant?.stopReason === "stop" &&
          !contentToText(this.lastAssistant.content).trim(),
      });
      this.partialId = undefined;
      this.lastAssistant = undefined;
    }
    if (oldRun !== undefined && newRun !== undefined && oldRun !== newRun)
      events.push({ type: "run_started", id: newRun });

    if (after.generation?.message && after.run) {
      const messageId = generationId(after);
      const text = contentToText(after.generation.message.content);
      const previousText = contentToText(before.generation?.message?.content);
      if (messageId !== this.partialId || text !== previousText)
        events.push({ type: "assistant_text", messageId, text });
      this.partialId = messageId;
    }
    for (const task of after.compactions ?? []) {
      if (!before.compactions?.some((old) => old.taskId === task.taskId)) {
        events.push(
          { type: "segment_break" },
          { type: "compaction_start", reason: task.reason },
        );
      }
    }
    for (const change of publication.changes) {
      if (
        change.type === "submission" &&
        change.value.conversationId === id &&
        change.value.type === "input" &&
        change.value.status === "unanswered" &&
        change.value.reason !== "aborted"
      ) {
        events.push({
          type: "submission_failed",
          message:
            typeof change.value.detail === "string"
              ? change.value.detail
              : change.value.reason,
        });
      }
      if (
        change.type === "task" &&
        change.value.conversationId === id &&
        change.value.kind === "pi.compaction" &&
        change.value.state.status === "terminal"
      ) {
        const outcome = change.value.state.outcome;
        const result =
          outcome.status === "completed"
            ? (outcome.result as { entryId?: number; submissionId?: number })
            : undefined;
        events.push({
          type: "compaction_end",
          aborted: outcome.status === "aborted",
          errorMessage:
            outcome.status === "failed" || outcome.status === "faulted"
              ? outcome.error.message
              : outcome.status === "orphaned"
                ? outcome.reason
                : undefined,
          skipped:
            outcome.status === "completed" &&
            result?.entryId === undefined &&
            result?.submissionId === undefined,
        });
      }
    }
    this.previous = view;
    return events;
  }
}

/** Local delivery watermarks synchronize output without changing the transcript. */
export class OutputDelivery {
  private pending: { sequence: number; events: RunnerEvent[] }[] = [];
  private sequence = 0;
  private delivered = 0;
  private pumping = false;
  private waiters: { sequence: number; resolve: () => void }[] = [];
  constructor(private readonly callback: RunnerOutputCallback) {}

  enqueue(events: RunnerEvent[]): void {
    if (!events.length) return;
    const sequence = ++this.sequence;
    const tail = this.pending.at(-1);
    if (
      tail?.events.length === 1 &&
      events.length === 1 &&
      tail.events[0]?.type === "assistant_text" &&
      events[0]?.type === "assistant_text" &&
      tail.events[0].messageId === events[0].messageId
    ) {
      // Slow transports need the latest committed text, not every obsolete partial.
      tail.events = events;
      tail.sequence = sequence;
    } else this.pending.push({ sequence, events });
    if (!this.pumping) {
      this.pumping = true;
      queueMicrotask(() => {
        void this.pump();
      });
    }
  }
  async flush(): Promise<void> {
    const sequence = this.sequence;
    if (this.delivered >= sequence) return;
    await new Promise<void>((resolve) =>
      this.waiters.push({ sequence, resolve }),
    );
  }
  private async pump(): Promise<void> {
    try {
      for (
        let batch = this.pending.shift();
        batch;
        batch = this.pending.shift()
      ) {
        for (const event of batch.events) {
          try {
            await this.callback(event);
          } catch (error) {
            log.error("output delivery failed", error);
          }
        }
        this.delivered = batch.sequence;
        this.waiters = this.waiters.filter((waiter) => {
          if (waiter.sequence > this.delivered) return true;
          waiter.resolve();
          return false;
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}

export class ConversationOutput {
  private readonly delivery: OutputDelivery;
  private readonly unsubscribe: () => void;
  private committedDocs: ConversationView["docs"];
  constructor(
    harness: Harness,
    readonly state: AttachedReplicatedState<ConversationView>,
    callback: RunnerOutputCallback,
  ) {
    this.committedDocs = state.value.docs;
    this.delivery = new OutputDelivery(callback);
    const projection = new ConversationProjection(state.value);
    this.delivery.enqueue(projection.attach());
    // Chord delivers viewState frames in a microtask. Read the publication's
    // full document values here so run completion and its final text use the
    // same committed revision, even before those frames arrive.
    this.unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (
          change.type !== "document" ||
          change.conversationId !== state.value.conversation.id ||
          change.record.key !== undefined
        )
          continue;
        if (
          !["pi.live", "pi.inbox", "pi.usage", "pi.agent"].includes(
            change.record.kind,
          )
        )
          continue;
        const docs = { ...this.committedDocs };
        if (change.value === null) delete docs[change.record.kind];
        else docs[change.record.kind] = change.value;
        this.committedDocs = docs;
      }
      this.delivery.enqueue(
        projection.accept(publication, {
          ...state.value,
          docs: this.committedDocs,
        }),
      );
    });
  }
  get docs(): ConversationView["docs"] {
    return this.committedDocs;
  }
  flush(): Promise<void> {
    return this.delivery.flush();
  }
  async close(): Promise<void> {
    this.unsubscribe();
    await this.flush();
    this.state.dispose();
  }
}

function liveState(view: ConversationView): LiveState {
  return (view.docs["pi.live"] ?? {}) as LiveState;
}
function generationId(live: LiveState): string {
  return `generation:${live.run!.taskId}:${live.generation!.attempt}`;
}
function toolStart(
  slot: ToolSlot,
  entries: readonly EntryRecord[],
  publication?: CommitPublication,
): RunnerEvent {
  const task = publication?.changes.find(
    (change) => change.type === "task" && change.value.id === slot.taskId,
  );
  const checkpoint =
    task?.type === "task" &&
    (task.value.state.status === "running" ||
      task.value.state.status === "pending")
      ? (task.value.state.checkpoint as { arguments?: unknown })
      : undefined;
  const call = entries
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .find((block) => block.type === "toolCall" && block.id === slot.callId);
  return {
    type: "tool_execution_start",
    toolCallId: slot.callId,
    toolName: slot.name,
    args:
      checkpoint?.arguments ??
      (call?.type === "toolCall" ? call.arguments : {}),
  };
}
