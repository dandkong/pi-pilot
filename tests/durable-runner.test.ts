import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { RunnerEvent } from "../src/pi/events.ts";
import { PiRunner } from "../src/pi/runner.ts";
import { configureLogger } from "../src/logger.ts";

configureLogger("silent");
const runners: PiRunner[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture(tokensPerSecond = 100_000) {
  const dir = await mkdtemp(join(tmpdir(), "pilot-durable-test-"));
  dirs.push(dir);
  const workspace = join(dir, "project");
  const secondWorkspace = join(dir, "other-project");
  await mkdir(workspace);
  await mkdir(secondWorkspace);
  const faux = fauxProvider({
    tokensPerSecond,
    models: [
      { id: "faux-1", name: "A", reasoning: true, contextWindow: 250_000 },
      { id: "faux-2", name: "B", reasoning: false, contextWindow: 250_000 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const config = {
    telegramToken: "test",
    workspaces: [workspace, secondWorkspace],
    allowedActorIds: ["1"],
    logLevel: "silent" as const,
  };
  const events: RunnerEvent[] = [];
  function createRunner() {
    const runner = new PiRunner(config, { models, dataDir: join(dir, "data") });
    runner.setOutputCallback((event) => {
      events.push(event);
    });
    runners.push(runner);
    return runner;
  }
  const runner = createRunner();
  await runner.init();
  return {
    runner,
    faux,
    workspace,
    secondWorkspace,
    events,
    createRunner,
    config,
    dir,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for durable state");
    await Bun.sleep(10);
  }
}

describe("durable runner", () => {
  test("real coding tools run in the workspace and committed text streams once", async () => {
    const { runner, faux, workspace, events } = await fixture();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("write", { path: "hello.txt", content: "hello\n" }),
          fauxToolCall("read", { path: "hello.txt" }),
          fauxToolCall("edit", {
            path: "hello.txt",
            oldText: "hello",
            newText: "world",
          }),
          fauxToolCall("bash", { command: "echo durable" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        const results = context.messages.filter((m) => m.role === "toolResult");
        expect(results).toHaveLength(4);
        expect(results.every((result) => !result.isError)).toBe(true);
        return fauxAssistantMessage("Done: world.");
      },
    ]);
    await runner.run("Change the greeting.");
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe(
      "world\n",
    );
    expect(
      events
        .filter((e) => e.type === "message_update")
        .map((e) => e.assistantMessageEvent.delta)
        .join(""),
    ).toBe("Done: world.");
    expect(
      events.filter((e) => e.type === "tool_execution_start"),
    ).toHaveLength(4);
    expect(events.at(-1)?.type).toBe("agent_settled");
    const status = await runner.getStatus();
    expect(status.isStreaming).toBe(false);
    expect(status.stats.toolResults).toBe(4);
    expect(status.activeTools).toEqual(["read", "write", "edit", "bash"]);
  });

  test("sessions and workspace selections survive reload and restart", async () => {
    const { runner, faux, createRunner, secondWorkspace } = await fixture();
    faux.setResponses([
      fauxAssistantMessage("First answer."),
      fauxAssistantMessage("Second answer."),
    ]);
    const first = (await runner.getStatus()).sessionId;
    await runner.run("First question");
    const second = await runner.newSession();
    await runner.run("Second question");
    expect(first).not.toBe(second);
    const sessions = await runner.listSessions();
    await runner.switchSession(sessions.findIndex((s) => s.id === first));
    await runner.reload();
    expect((await runner.getStatus()).sessionId).toBe(first);
    await runner.switchWorkspace(1);
    expect((await runner.getStatus()).cwd).toBe(secondWorkspace);
    expect(await runner.getRecentMessages()).toEqual([]);
    await runner.switchWorkspace(0);
    expect((await runner.getStatus()).sessionId).toBe(first);
    await runner.dispose();
    const reopened = createRunner();
    await reopened.init();
    expect((await reopened.getStatus()).sessionId).toBe(first);
    expect(await reopened.getRecentMessages()).toEqual([
      { role: "User", text: "First question" },
      { role: "Assistant", text: "First answer." },
    ]);
  });

  test("request IDs deduplicate Telegram redelivery", async () => {
    const { runner, faux } = await fixture();
    faux.setResponses([fauxAssistantMessage("One answer.")]);
    await runner.run("Hello", { requestId: "telegram:1:42" });
    await runner.run("Hello", { requestId: "telegram:1:42" });
    expect(faux.state.callCount).toBe(1);
    expect((await runner.getStatus()).stats.userMessages).toBe(1);
  });

  test("steers are admitted immediately and enter the next model turn", async () => {
    const { runner, faux, events } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage(
          fauxToolCall("write", { path: "note.txt", content: "ok" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect(
          context.messages.some(
            (m) => m.role === "user" && m.content === "Use TypeScript",
          ),
        ).toBe(true);
        return fauxAssistantMessage("Using TypeScript.");
      },
    ]);
    const running = runner.run("Create a note");
    await waitUntil(() => faux.state.callCount === 1);
    try {
      await runner.run("Use TypeScript", { streamingBehavior: "steer" });
      expect((await runner.getRuntimeStatus()).pendingMessages).toBe(1);
      expect((await runner.getRuntimeStatus()).isStreaming).toBe(true);
    } finally {
      release();
    }
    await running;
    expect(
      events.some((e) => e.type === "queue_update" && e.steering.length === 1),
    ).toBe(true);
    expect((await runner.getRuntimeStatus()).pendingMessages).toBe(0);
  });

  test("stop cancels a live generation and its queued steer", async () => {
    const { runner, faux } = await fixture(10);
    faux.setResponses([
      fauxAssistantMessage("An answer that would take a long time to stream."),
    ]);
    const running = runner.run("Work slowly");
    await waitUntil(() => faux.state.callCount === 1);
    await runner.run("Queued instruction", { streamingBehavior: "steer" });
    await runner.abort();
    await running;
    expect(await runner.getRuntimeStatus()).toEqual({
      isStreaming: false,
      isCompacting: false,
      pendingMessages: 0,
    });
  });

  test("closing preserves unfinished work and reopening resumes it", async () => {
    const { runner, faux, createRunner } = await fixture(10);
    faux.setResponses([
      fauxAssistantMessage("A deliberately slow unfinished answer."),
    ]);
    const originalId = (await runner.getStatus()).sessionId;
    const interrupted = runner.run("Recover this input").catch(() => {});
    await waitUntil(() => faux.state.callCount === 1);
    await runner.dispose();
    await interrupted;
    faux.setResponses([fauxAssistantMessage("Recovered.")]);
    const reopened = createRunner();
    await reopened.init();
    await waitUntil(
      async () => !(await reopened.getRuntimeStatus()).isStreaming,
    );
    expect((await reopened.getStatus()).sessionId).toBe(originalId);
    expect((await reopened.getRecentMessages()).at(-1)).toEqual({
      role: "Assistant",
      text: "Recovered.",
    });
  }, 10_000);

  test("model and thinking selections persist, invalid thinking is rejected", async () => {
    const { runner } = await fixture();
    expect((await runner.getProviderModels())[0]?.models).toHaveLength(2);
    await runner.setThinkingLevel("high");
    await runner.reload();
    expect((await runner.getStatus()).thinkingLevel).toBe("high");
    await runner.setModel("faux", 1);
    expect((await runner.getStatus()).model?.id).toBe("faux-2");
    expect((await runner.getStatus()).thinkingLevel).toBe("off");
    await expect(runner.setThinkingLevel("max")).rejects.toThrow(
      "Unsupported thinking level",
    );
  });

  test("a killed process recovers the committed input without a graceful close", async () => {
    const { runner, faux, createRunner, config, dir } = await fixture();
    await runner.dispose();
    const script = `
      import { createModels } from '@earendil-works/pi-ai/models';
      import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
      import { PiRunner } from './src/pi/runner.ts';
      const faux = fauxProvider({ tokensPerSecond: 1 });
      const models = createModels(); models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('This output should be interrupted by a hard process kill.')]);
      const runner = new PiRunner(${JSON.stringify(config)}, { models, dataDir: ${JSON.stringify(join(dir, "data"))} });
      await runner.init();
      const running = runner.run('Persist before crashing', { requestId: 'crash-test' });
      while (faux.state.callCount === 0) await Bun.sleep(5);
      console.log('CRASH_READY');
      await running;
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let output = "";
      const ready = (async () => {
        while (!output.includes("CRASH_READY")) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`Child exited before admission: ${output}`);
          output += new TextDecoder().decode(value);
        }
      })();
      await Promise.race([
        ready,
        Bun.sleep(5_000).then(() => {
          throw new Error("Crash fixture did not start");
        }),
      ]);
      child.kill();
      await child.exited;
      faux.setResponses([fauxAssistantMessage("Recovered after hard kill.")]);
      const reopened = createRunner();
      await reopened.init();
      await waitUntil(
        async () => !(await reopened.getRuntimeStatus()).isStreaming,
      );
      expect(await reopened.getRecentMessages()).toEqual([
        { role: "User", text: "Persist before crashing" },
        { role: "Assistant", text: "Recovered after hard kill." },
      ]);
      await reopened.run("Persist before crashing", {
        requestId: "crash-test",
      });
      expect(faux.state.callCount).toBe(1);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 10_000);

  test("manual compaction writes a summary and preserves the old transcript", async () => {
    const { runner, faux, events } = await fixture();
    faux.setResponses([
      fauxAssistantMessage("First answer."),
      fauxAssistantMessage("Recent answer."),
      fauxAssistantMessage("Summary of the earlier work."),
    ]);
    await runner.run("Old context. ".repeat(10_000));
    await runner.run("Recent context. ".repeat(6_000));
    await runner.compact();
    expect(faux.state.callCount).toBe(3);
    expect(
      (await runner.getRecentMessages()).some(
        (m) =>
          m.role === "Summary" &&
          m.text.includes("Summary of the earlier work."),
      ),
    ).toBe(true);
    expect(
      (await runner.getStatus()).stats.userMessages,
    ).toBeGreaterThanOrEqual(2);
    expect(
      events.some(
        (e) => e.type === "compaction_end" && !e.skipped && !e.errorMessage,
      ),
    ).toBe(true);
  });

  test("short compaction reports a skip without calling the model", async () => {
    const { runner, faux, events } = await fixture();
    await runner.compact();
    expect(faux.state.callCount).toBe(0);
    expect(events.some((e) => e.type === "compaction_end" && e.skipped)).toBe(
      true,
    );
    expect((await runner.getRuntimeStatus()).isCompacting).toBe(false);
  });
});
