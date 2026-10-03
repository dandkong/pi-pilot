import { expect, test } from "bun:test";
import type { ChatAdapter } from "../src/adapters/types.ts";
import { createTurnStreamSender } from "../src/render/turn-stream.ts";

function fixture(interval = 10_000) {
  const updates: string[] = [];
  const finished: string[] = [];
  const adapter: ChatAdapter = {
    async start() {},
    async stop() {},
    async sendMessage(_chatId, text) {
      finished.push(text);
      return [];
    },
    async editMessage() {},
    async startTextStream() {
      return {
        async update(text) {
          updates.push(text);
        },
        async finish(text) {
          finished.push(text);
        },
      };
    },
    getStreamUpdateIntervalMs() {
      return interval;
    },
    async sendTyping() {},
    async reactToMessage() {},
    async answerCallback() {},
    onMessage() {},
    onCallback() {},
  };
  return {
    sender: createTurnStreamSender(adapter, { chatId: "test" }),
    updates,
    finished,
  };
}

test("committed text can replace or shrink a partial instead of appending it again", async () => {
  const { sender, finished } = fixture();
  await sender.pushAssistantText("one", "The speculative longer answer");
  await sender.pushAssistantText("one", "Correct answer");
  await sender.pushAssistantText("one", "Correct");
  await sender.finish("");
  expect(finished).toEqual(["Correct"]);
});

test("steering splits a continuing snapshot without replaying its prefix", async () => {
  const { sender, finished } = fixture();
  await sender.pushAssistantText("one", "Before steering.");
  await sender.breakSegment();
  await sender.pushAssistantText("one", "Before steering. After steering.");
  await sender.pushAssistantText("two", "New model turn.");
  await sender.finish("");
  expect(finished).toEqual([
    "Before steering.",
    "After steering.",
    "New model turn.",
  ]);
});

test("tools separate assistant turns even when the tool-calling message has no text", async () => {
  const { sender, finished } = fixture();
  await sender.pushAssistantText("one", "");
  await sender.pushToolStart({ toolName: "write", args: { path: "note.txt" } });
  await sender.pushAssistantText("two", "Done.");
  await sender.finish("");
  expect(finished).toEqual(["📄 write: note.txt", "Done."]);
});

test("disposing a stream cancels scheduled updates", async () => {
  const { sender, finished, updates } = fixture(30);
  await sender.pushAssistantText("one", "Unfinished partial");
  await sender.cancel();
  await Bun.sleep(60);
  expect(updates).toEqual([]);
  expect(finished).toEqual([]);
});
