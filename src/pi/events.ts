import type { CompactionReason } from "@earendil-works/pi-durable";

/** Presentation of committed durable state. Text updates replace a message. */
export type RunnerEvent =
  | { type: "conversation_attached" }
  | { type: "run_started"; id: number }
  | { type: "run_finished"; id: number; emptyAnswer?: boolean }
  | { type: "assistant_text"; messageId: string; text: string }
  | { type: "segment_break" }
  | { type: "submission_failed"; message: string }
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
