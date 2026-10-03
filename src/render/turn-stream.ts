import type {
  ChatAdapter,
  MessageRenderMode,
  SendMessageOptions,
} from "../adapters/types.ts";
import type { ToolEvent } from "../pi/types.ts";
import { logger } from "../logger.ts";
import { formatToolStart } from "./tool-format.ts";
const log = logger.child("render");
export type ChatTarget = { chatId: string; replyToMessageId?: string };

export function createTurnStreamSender(
  adapter: ChatAdapter,
  target: ChatTarget,
) {
  type SegmentKind = "text" | "tool";

  let currentOutput: ReturnType<typeof createTextStreamSender> | undefined;
  let currentKind: SegmentKind | undefined;
  let hasSentSegment = false;
  let assistantId: string | undefined;
  let assistantText = "";
  let segmentOffset = 0;
  let pending = Promise.resolve();

  const switchTo = async (kind: SegmentKind) => {
    if (currentKind === kind && currentOutput) return currentOutput;

    if (currentOutput && (await currentOutput.finish())) {
      hasSentSegment = true;
    }

    currentKind = kind;
    currentOutput = createTextStreamSender(
      adapter,
      target,
      kind === "tool" ? "plain" : "markdown",
    );
    return currentOutput;
  };

  const queue = (task: () => Promise<void>) => {
    pending = enqueueStreamTask(
      pending,
      task,
      `[chat ${target.chatId}] turn stream failed`,
    );
    return pending;
  };

  return {
    pushAssistantText(messageId: string, text: string) {
      return queue(async () => {
        if (assistantId !== messageId) {
          if (currentKind === "text" && currentOutput) {
            hasSentSegment = (await currentOutput.finish()) || hasSentSegment;
            currentOutput = undefined;
            currentKind = undefined;
          }
          assistantId = messageId;
          segmentOffset = 0;
        } else if (!text.startsWith(assistantText.slice(0, segmentOffset))) {
          // A provider can replace or shrink a partial message.
          segmentOffset = 0;
        }
        assistantText = text;
        if (!text.slice(segmentOffset).trim() && currentKind !== "text") return;
        const output = await switchTo("text");
        output.setText(text.slice(segmentOffset));
      });
    },
    pushToolStart(event: ToolEvent) {
      return queue(async () => {
        const output = await switchTo("tool");
        output.append(`${formatToolStart(event)}\n`, { immediate: true });
      });
    },
    breakSegment() {
      return queue(async () => {
        if (currentOutput && (await currentOutput.finish())) {
          hasSentSegment = true;
        }
        currentOutput = undefined;
        currentKind = undefined;
        segmentOffset = assistantText.length;
      });
    },
    async cancel() {
      await pending;
      await currentOutput?.cancel();
      currentOutput = undefined;
      currentKind = undefined;
    },
    async finish(fallbackText: string) {
      await pending;
      if (!currentOutput && !hasSentSegment && fallbackText.trim()) {
        currentKind = "text";
        currentOutput = createTextStreamSender(adapter, target, "markdown");
      }
      const sentCurrent = await currentOutput?.finish(
        hasSentSegment ? "" : fallbackText,
      );
      hasSentSegment = hasSentSegment || !!sentCurrent;
    },
  };
}

function createTextStreamSender(
  adapter: ChatAdapter,
  target: ChatTarget,
  render: MessageRenderMode,
) {
  let text = "";
  let stream: Awaited<ReturnType<ChatAdapter["startTextStream"]>>;
  let streamStarted = false;
  let pending = Promise.resolve();
  let scheduled: Timer | undefined;
  const streamOptions: SendMessageOptions = {
    render,
    replyToMessageId: target.replyToMessageId,
  };
  // Rewriting a persisted Telegram message is rate limited, so the adapter owns
  // the cadence instead of the runtime hardcoding one.
  const minUpdateIntervalMs = adapter.getStreamUpdateIntervalMs();
  // Seed with the creation time so the first flush waits one full interval
  // rather than firing immediately on the very first token.
  let lastUpdatedAt = Date.now();

  const startStream = async () => {
    if (streamStarted) return stream;
    streamStarted = true;
    stream = await adapter.startTextStream(target.chatId, streamOptions);
    return stream;
  };

  const queue = (task: () => Promise<void>) => {
    pending = enqueueStreamTask(
      pending,
      task,
      `[chat ${target.chatId}] response stream failed`,
    );
    return pending;
  };

  const update = () =>
    queue(async () => {
      const current = text;
      if (!current.trim()) return;
      const activeStream = await startStream();
      if (!activeStream) return;
      await activeStream.update(current);
      lastUpdatedAt = Date.now();
    });

  const scheduleUpdate = () => {
    if (scheduled) return;
    // Sleep exactly until the next update becomes legal. A fixed retry tick
    // would silently cap the adapter's interval at the tick length.
    const delay = Math.max(
      0,
      minUpdateIntervalMs - (Date.now() - lastUpdatedAt),
    );
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (Date.now() - lastUpdatedAt < minUpdateIntervalMs) {
        scheduleUpdate();
        return;
      }
      update();
    }, delay);
  };

  return {
    setText(value: string) {
      text = value;
      scheduleUpdate();
    },
    async cancel() {
      if (scheduled) clearTimeout(scheduled);
      scheduled = undefined;
      await pending;
    },
    append(delta: string, options: { immediate?: boolean } = {}) {
      text += delta;
      if (options.immediate) {
        update();
        return;
      }
      scheduleUpdate();
    },
    async finish(fallbackText = ""): Promise<boolean> {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = undefined;
      }
      await pending;
      const finalText = text.trim() || fallbackText.trim();
      if (!finalText) return false;
      const activeStream = await startStream();
      if (activeStream) {
        await activeStream.finish(finalText);
        return true;
      }
      await adapter.sendMessage(target.chatId, finalText, {
        render,
        replyToMessageId: target.replyToMessageId,
      });
      return true;
    },
  };
}

function enqueueStreamTask(
  pending: Promise<void>,
  task: () => Promise<void>,
  errorMessage: string,
): Promise<void> {
  return pending.then(task).catch((error) => {
    log.warn(errorMessage, error);
  });
}
