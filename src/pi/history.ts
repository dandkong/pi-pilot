import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  Cursor,
  EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import type { RecentMessage, RunnerStatus } from "./types.ts";

const context = BACKGROUND_CONTEXT;
type Summary = {
  stats: Omit<RunnerStatus["stats"], "cost">;
  firstMessage: string;
};

/** Reads history lazily, invalidating cached totals only on transcript commits. */
export class ConversationHistory {
  private summaries = new Map<number, Summary>();
  private revisions = new Map<number, number>();
  private readonly unsubscribe: () => void;
  constructor(harness: Harness) {
    this.unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== "entry") continue;
        const id = change.value.conversationId;
        this.summaries.delete(id);
        this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
      }
    });
  }
  async summary(conversation: Conversation): Promise<Summary> {
    const cached = this.summaries.get(conversation.id);
    if (cached) return cached;
    const revision = this.revisions.get(conversation.id);
    const stats = {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
    };
    let firstMessage = "";
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 250, cursor, context);
      for (const entry of page.items) {
        for (const message of entry.model ?? []) {
          if (message.role === "system") continue;
          stats.totalMessages++;
          if (message.role === "user") {
            stats.userMessages++;
            if (entry.kind === "pi.user")
              firstMessage = contentToText(message.content);
          }
          if (message.role === "assistant") {
            stats.assistantMessages++;
            stats.toolCalls += message.content.filter(
              (block) => block.type === "toolCall",
            ).length;
          }
          if (message.role === "toolResult") stats.toolResults++;
        }
      }
      cursor = page.next;
    } while (cursor);
    const summary = { stats, firstMessage };
    if (this.revisions.get(conversation.id) === revision)
      this.summaries.set(conversation.id, summary);
    return summary;
  }
  async latestActivity(
    conversation: Conversation,
    created: number,
  ): Promise<number> {
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 16, cursor, context);
      for (const entry of page.items) {
        const message = entry.model?.[0];
        if (message) return Math.max(created, message.timestamp);
      }
      cursor = page.next;
    } while (cursor);
    return created;
  }
  async recent(
    conversation: Conversation,
    limit: number,
  ): Promise<RecentMessage[]> {
    if (limit <= 0) return [];
    const messages: RecentMessage[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(
        {},
        Math.max(16, limit),
        cursor,
        context,
      );
      for (const entry of page.items) {
        const message = recentMessage(entry);
        if (message?.text.trim()) messages.push(message);
        if (messages.length >= limit) return messages.reverse();
      }
      cursor = page.next;
    } while (cursor);
    return messages.reverse();
  }
  dispose(): void {
    this.unsubscribe();
    this.summaries.clear();
    this.revisions.clear();
  }
}

function recentMessage(entry: EntryRecord): RecentMessage | undefined {
  const message = entry.model?.[0];
  if (!message) return;
  if (entry.kind === "pi.compaction")
    return { role: "Summary", text: contentToText(message.content) };
  if (message.role === "user")
    return { role: "User", text: contentToText(message.content) };
  if (message.role === "assistant")
    return { role: "Assistant", text: contentToText(message.content) };
}
export function contentToText(content: unknown): string {
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
    .join("");
}
