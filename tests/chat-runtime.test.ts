import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  ChatAdapter,
  ChatMessage,
  SendMessageOptions,
} from "../src/adapters/types.ts";
import { PiRunner } from "../src/pi/runner.ts";
import { ChatRuntime } from "../src/runtime/chat-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pilot-chat-test-"));
  const workspace = join(dir, "project");
  await mkdir(workspace);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const config = {
    telegramToken: "test",
    workspaces: [workspace],
    allowedActorIds: ["1"],
    defaultTargetId: "-10042",
    logLevel: "silent" as const,
  };
  const runner = new PiRunner(config, { models });
  const sent: { chatId: string; text: string; options?: SendMessageOptions }[] =
    [];
  const reactions: string[] = [];
  const adapter: ChatAdapter = {
    async start() {},
    async stop() {},
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return [{ messageId: "sent" }];
    },
    async editMessage() {},
    async startTextStream(chatId, options) {
      return {
        async update() {},
        async finish(text) {
          sent.push({ chatId, text, options });
        },
      };
    },
    getStreamUpdateIntervalMs() {
      return 1;
    },
    async sendTyping() {},
    async reactToMessage(_chatId, messageId) {
      reactions.push(messageId);
    },
    async answerCallback() {},
    onMessage() {},
    onCallback() {},
  };
  const runtime = new ChatRuntime(config, adapter, { runner });
  cleanups.push(async () => {
    await runtime.dispose();
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await runtime.warmup();
  const message = (text: string, id = "1"): ChatMessage => ({
    platform: "telegram",
    chatId: "-10042",
    userId: "1",
    messageId: id,
    text,
  });
  return { runtime, runner, faux, sent, reactions, message };
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Chat output timed out");
    await Bun.sleep(10);
  }
}

test("Telegram streams text and tool segments, redelivered messages do not run twice", async () => {
  const { runtime, faux, sent, message } = await fixture();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "output.txt", content: "ok" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("**Done.**"),
  ]);
  await runtime.handleMessage(message("Create a file", "42"));
  await waitUntil(() => sent.some((m) => m.text === "**Done.**"));
  expect(
    sent.some(
      (m) => m.text.includes("write:") && m.options?.render === "plain",
    ),
  ).toBe(true);
  expect(sent.find((m) => m.text === "**Done.**")?.options?.render).toBe(
    "markdown",
  );
  await runtime.handleMessage(message("Create a file", "42"));
  await Bun.sleep(50);
  expect(faux.state.callCount).toBe(2);
  expect(sent.filter((m) => m.text === "**Done.**")).toHaveLength(1);
});

test("mid-run messages persist in the durable inbox and receive eyes acknowledgement", async () => {
  const { runtime, runner, faux, reactions, sent, message } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage(
        fauxToolCall("write", { path: "file.txt", content: "ok" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      expect(
        context.messages.some(
          (m) => m.role === "user" && m.content === "Also test it",
        ),
      ).toBe(true);
      return fauxAssistantMessage("Tested.");
    },
  ]);
  await runtime.handleMessage(message("Create it", "10"));
  await waitUntil(() => faux.state.callCount === 1);
  try {
    await runtime.handleMessage(message("Also test it", "11"));
    expect(reactions).toEqual(["11"]);
    expect((await runner.getRuntimeStatus()).pendingMessages).toBe(1);
  } finally {
    release();
  }
  await waitUntil(() => sent.some((m) => m.text === "Tested."));
});

test("provider errors surface once and the next message can run", async () => {
  const { runtime, faux, sent, message } = await fixture();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Invalid API key",
    }),
    fauxAssistantMessage("Recovered."),
  ]);
  await runtime.handleMessage(message("Fail", "20"));
  await waitUntil(() =>
    sent.some((m) => m.text.includes("Pi failed: Invalid API key")),
  );
  await runtime.handleMessage(message("Retry", "21"));
  await waitUntil(() => sent.some((m) => m.text === "Recovered."));
  expect(sent.filter((m) => m.text.includes("Pi failed:"))).toHaveLength(1);
});

test("authorization and short-compaction feedback still work", async () => {
  const { runtime, faux, sent, message } = await fixture();
  await runtime.handleMessage({ ...message("Do something"), userId: "2" });
  expect(faux.state.callCount).toBe(0);
  expect(sent.at(-1)?.text).toBe("Unauthorized user: 2");
  await runtime.handleMessage(message("/compact", "30"));
  expect(sent.some((m) => m.text === "Context is too short to compact.")).toBe(
    true,
  );
  await runtime.handleMessage(message("/help", "31"));
  expect(sent.at(-1)?.text).not.toContain("/delete");
});
