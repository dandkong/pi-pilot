import { expect, test } from "bun:test";
import { OutputDelivery } from "../src/pi/conversation-output.ts";
import type { RunnerEvent } from "../src/pi/events.ts";

test("slow delivery coalesces text snapshots while preserving boundaries and final completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: RunnerEvent[] = [];
  const delivery = new OutputDelivery(async (event) => {
    events.push(event);
    if (event.type === "run_started") await gate;
  });
  delivery.enqueue([{ type: "run_started", id: 1 }]);
  await Bun.sleep(0);
  for (let i = 0; i < 1_000; i++) {
    delivery.enqueue([
      { type: "assistant_text", messageId: "first", text: String(i) },
    ]);
  }
  delivery.enqueue([{ type: "segment_break" }]);
  delivery.enqueue([
    { type: "assistant_text", messageId: "first", text: "999 continued" },
  ]);
  delivery.enqueue([
    { type: "assistant_text", messageId: "second", text: "corrected final" },
  ]);
  delivery.enqueue([{ type: "run_finished", id: 1 }]);
  let flushed = false;
  const flush = delivery.flush().then(() => {
    flushed = true;
  });
  await Bun.sleep(0);
  expect(flushed).toBe(false);
  release();
  await flush;
  expect(events).toEqual([
    { type: "run_started", id: 1 },
    { type: "assistant_text", messageId: "first", text: "999" },
    { type: "segment_break" },
    { type: "assistant_text", messageId: "first", text: "999 continued" },
    { type: "assistant_text", messageId: "second", text: "corrected final" },
    { type: "run_finished", id: 1 },
  ]);
});

test("a failing output consumer does not strand delivery or later runs", async () => {
  const events: RunnerEvent[] = [];
  const delivery = new OutputDelivery((event) => {
    if (event.type === "assistant_text")
      throw new Error("Transport unavailable");
    events.push(event);
  });
  delivery.enqueue([
    { type: "assistant_text", messageId: "first", text: "answer" },
  ]);
  delivery.enqueue([{ type: "run_finished", id: 1 }]);
  await delivery.flush();
  delivery.enqueue([{ type: "run_started", id: 2 }]);
  await delivery.flush();
  expect(events.map((e) => e.type)).toEqual(["run_finished", "run_started"]);
});
