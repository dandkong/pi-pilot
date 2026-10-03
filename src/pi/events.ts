import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionReason } from "@earendil-works/pi-durable";

/** UI events independent of Pi's coding-agent session API. */
export type RunnerEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AssistantMessage[] }
  | { type: "agent_settled" }
  | { type: "segment_break" }
  | { type: "submission_failed"; message: string }
  | {
      type: "message_update";
      assistantMessageEvent: { type: "text_delta"; delta: string };
    }
  | {
      type: "queue_update";
      steering: readonly number[];
      followUp: readonly number[];
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      args: unknown;
    }
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      aborted?: boolean;
      errorMessage?: string;
      skipped?: boolean;
    };
