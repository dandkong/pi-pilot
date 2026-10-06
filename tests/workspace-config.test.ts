import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/runtime.ts";
import { workspacePaths } from "../src/config/paths.ts";
import { loadWorkspaceModels } from "../src/pi/model-config.ts";
import { FileCredentialStore } from "../src/pi/credentials.ts";
import { PiRunner } from "../src/pi/runner.ts";
import { saveAttachment } from "../src/adapters/attachments.ts";
import { WorkspaceExecutionEnv } from "../src/pi/execution-env.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

test("tool output spill files stay under the workspace temporary directory", async () => {
  const cwd = await directory();
  const env = new WorkspaceExecutionEnv(cwd, workspacePaths(cwd).tmp);
  try {
    const result = await env.exec(
      "printf 'one\\ntwo\\nthree\\nfour\\n'",
      { spill: { afterBytes: 4, afterLines: 1 } },
      BACKGROUND_CONTEXT,
    );
    if (!result.ok) throw result.error;
    expect(result.value.spillPath?.startsWith(workspacePaths(cwd).tmp)).toBe(
      true,
    );
    expect(await readFile(result.value.spillPath!, "utf8")).toBe(
      "one\ntwo\nthree\nfour\n",
    );
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
});

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "pilot-config-test-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(workspacePaths(cwd).config, { recursive: true });
  return cwd;
}
async function json(cwd: string, name: string, value: unknown) {
  await writeFile(
    join(workspacePaths(cwd).config, name),
    JSON.stringify(value),
  );
}

test("startup loads workspace secrets and settings without changing the process environment", async () => {
  const cwd = await directory();
  await writeFile(
    join(workspacePaths(cwd).config, ".env"),
    'TELEGRAM_BOT_TOKEN="workspace-token" # comment\nTELEGRAM_ALLOWED_USERS=1,2\nPI_PILOT_TEST_SECRET=local\n',
  );
  await json(cwd, "settings.json", { version: 1, logLevel: "debug" });
  const previous = process.env.PI_PILOT_TEST_SECRET;
  const config = loadConfig({ workspaces: cwd }, {});
  expect(config.telegramToken).toBe("workspace-token");
  expect(config.allowedActorIds).toEqual(["1", "2"]);
  expect(config.logLevel).toBe("debug");
  expect(
    loadConfig(
      { workspaces: cwd, telegramToken: "cli-token" },
      { TELEGRAM_BOT_TOKEN: "env-token" },
    ).telegramToken,
  ).toBe("cli-token");
  expect(
    loadConfig({ workspaces: cwd }, { TELEGRAM_BOT_TOKEN: "env-token" })
      .telegramToken,
  ).toBe("env-token");
  expect(process.env.PI_PILOT_TEST_SECRET).toBe(previous);
});

test("file credentials override environment keys and serialize concurrent updates across store instances", async () => {
  const cwd = await directory();
  await writeFile(
    join(workspacePaths(cwd).config, ".env"),
    "DEEPSEEK_API_KEY=environment-key\n",
  );
  await json(cwd, "auth.json", {
    deepseek: { type: "api_key", key: "stored-key" },
    counter: { type: "api_key", key: "0" },
  });
  const runtime = await loadWorkspaceModels(cwd);
  expect((await runtime.models.getAuth("deepseek"))?.auth.apiKey).toBe(
    "stored-key",
  );
  const path = join(workspacePaths(cwd).config, "auth.json");
  const a = new FileCredentialStore(path);
  const b = new FileCredentialStore(path);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? a : b).modify("counter", async (current) => {
        await Bun.sleep(1);
        return {
          type: "api_key",
          key: String(
            Number(current?.type === "api_key" ? current.key : "0") + 1,
          ),
        };
      }),
    ),
  );
  expect(await a.read("counter")).toEqual({ type: "api_key", key: "12" });
  expect(await a.list()).toContainEqual({
    providerId: "deepseek",
    type: "api_key",
  });
  await a.delete("deepseek");
  // Process env may override the local value, but the removed stored key cannot survive.
  expect((await runtime.models.getAuth("deepseek"))?.source).toBe(
    "DEEPSEEK_API_KEY",
  );
  expect((await runtime.models.getAuth("deepseek"))?.auth.apiKey).not.toBe(
    "stored-key",
  );
  expect(
    (await readdir(workspacePaths(cwd).config)).some((name) =>
      name.endsWith(".tmp"),
    ),
  ).toBe(false);
});

test("custom model JSON reaches the provider, profiles persist, workspaces isolate auth, and bad reload preserves the runtime", async () => {
  const requests: { headers: Headers; payload: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as Record<string, unknown>;
      requests.push({ headers: request.headers, payload });
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: payload.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
      return new Response(
        `data: ${chunk({ role: "assistant", content: `Answer ${payload.model}` })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanups.push(() => server.stop(true));
  const first = await directory();
  const second = await directory();
  const settings = (model: string) => ({
    version: 1,
    defaultProfile: "main",
    profiles: {
      main: { provider: "test-proxy", model, thinking: "high" },
      cheap: { provider: "test-proxy", model: "model-a", thinking: "low" },
    },
  });
  for (const [cwd, key, model] of [
    [first, "first-key", "model-a"],
    [second, "second-key", "model-b"],
  ] as const) {
    await writeFile(
      join(workspacePaths(cwd).config, ".env"),
      `PI_PILOT_TEST_KEY=${key}\nPI_PILOT_TEST_HEADER=${key}-header\n`,
    );
    await json(cwd, "settings.json", settings(model));
    await json(cwd, "models.json", {
      providers: {
        "test-proxy": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions",
          apiKey: "env:PI_PILOT_TEST_KEY",
          headers: { "X-Workspace": "env:PI_PILOT_TEST_HEADER" },
          compat: {
            supportsReasoningEffort: true,
            maxTokensField: "max_tokens",
            supportsStore: false,
          },
          request: { temperature: 0.2, maxTokens: 128 },
          models: ["model-a", "model-b"].map((id) => ({
            id,
            contextWindow: 32768,
            maxTokens: 4096,
            reasoning: true,
            samplingParams: { top_p: 0.7 },
          })),
          modelOverrides: {
            "model-a": { name: "Friendly name", request: { temperature: 0.3 } },
          },
        },
      },
    });
  }
  const config = {
    telegramToken: "test",
    workspaces: [first, second],
    allowedActorIds: ["1"],
    logLevel: "silent" as const,
  };
  const runner = new PiRunner(config);
  cleanups.push(() => runner.dispose());
  await runner.init();
  const session = (await runner.getStatus()).sessionId;
  expect((await runner.getStatus()).thinkingLevel).toBe("high");
  await runner.run("First request");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer first-key");
  expect(requests[0]?.headers.get("x-workspace")).toBe("first-key-header");
  expect(requests[0]?.payload).toMatchObject({
    model: "model-a",
    temperature: 0.3,
    max_tokens: 128,
    top_p: 0.7,
    reasoning_effort: "high",
  });
  expect((await runner.getStatus()).model?.name).toBe("Friendly name");
  expect(
    await readFile(join(workspacePaths(first).sessions, "main.jsonl"), "utf8"),
  ).toContain("First request");
  await runner.setProfile("cheap");
  await runner.reload();
  expect((await runner.getStatus()).thinkingLevel).toBe("low");
  await json(first, "settings.json", settings("model-b"));
  await runner.reload();
  expect((await runner.getStatus()).model?.id).toBe("model-a");
  expect((await runner.getStatus()).thinkingLevel).toBe("low");
  await runner.newSession();
  expect((await runner.getStatus()).model?.id).toBe("model-b");
  expect((await runner.getStatus()).thinkingLevel).toBe("high");
  await runner.switchSession(
    (await runner.listSessions()).findIndex((item) => item.id === session),
  );
  await writeFile(
    join(workspacePaths(first).config, "models.json"),
    '{"apiKey":"secret-that-must-not-leak"',
  );
  const error = await runner.reload().catch((error: Error) => error);
  expect(String(error)).toContain("Invalid JSON");
  expect(String(error)).not.toContain("secret-that-must-not-leak");
  expect((await runner.getStatus()).sessionId).toBe(session);
  await runner.run("Still works after failed reload");
  await runner.switchWorkspace(1);
  expect((await runner.getStatus()).model?.id).toBe("model-b");
  expect(await runner.getRecentMessages()).toEqual([]);
  await runner.run("Second workspace");
  expect(requests.at(-1)?.headers.get("authorization")).toBe(
    "Bearer second-key",
  );
  await expect(
    runner.submit("Late attachment", { workspace: first }),
  ).rejects.toThrow("Workspace changed");
  // Failed switch validates before closing the second workspace.
  await expect(runner.switchWorkspace(0)).rejects.toThrow("Invalid JSON");
  expect((await runner.getStatus()).cwd).toBe(second);
  await runner.dispose();
  // Reopen the valid second workspace directly.
  const restart = new PiRunner({ ...config, workspaces: [second] });
  cleanups.push(() => restart.dispose());
  await restart.init();
  expect((await restart.getRecentMessages()).at(-1)?.text).toBe(
    "Answer model-b",
  );
});

test("settings and model errors fail before starting a session", async () => {
  const cwd = await directory();
  await json(cwd, "settings.json", { version: 1, defaultProfile: "missing" });
  await expect(loadWorkspaceModels(cwd)).rejects.toThrow(
    "Unknown defaultProfile",
  );
  await json(cwd, "settings.json", {
    version: 1,
    profiles: { bad: { provider: "deepseek", model: "missing" } },
  });
  await expect(loadWorkspaceModels(cwd)).rejects.toThrow("unknown model");
  await json(cwd, "settings.json", {
    version: 1,
    profiles: {
      bad: { provider: "deepseek", model: "deepseek-flash", thinking: "xhigh" },
    },
  });
  await expect(loadWorkspaceModels(cwd)).rejects.toThrow(
    "unsupported thinking",
  );
  await json(cwd, "settings.json", { version: 1 });
  await json(cwd, "models.json", {
    providers: {
      bad: {
        api: "unknown",
        baseUrl: "http://localhost",
        keyless: true,
        models: [{ id: "a", contextWindow: 10000, maxTokens: 1000 }],
      },
    },
  });
  await expect(loadWorkspaceModels(cwd)).rejects.toThrow("custom api unknown");
});

test("attachments use unique persistent workspace paths and failed downloads leave no temporary files", async () => {
  const cwd = await directory();
  const bytes = new TextEncoder().encode("hello").buffer;
  const a = await saveAttachment(cwd, "../../test.txt", async () => bytes);
  const b = await saveAttachment(cwd, "test.txt", async () => bytes);
  expect(a).not.toBe(b);
  expect(a.startsWith(workspacePaths(cwd).attachments)).toBe(true);
  expect(await readFile(a, "utf8")).toBe("hello");
  expect(await readFile(b, "utf8")).toBe("hello");
  await expect(
    saveAttachment(cwd, "failed.txt", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(await readdir(workspacePaths(cwd).tmp)).toEqual([]);
});

test("invalid edits to auth.json do not replace the credentials of an already loaded runtime", async () => {
  const cwd = await directory();
  await json(cwd, "auth.json", {
    deepseek: { type: "api_key", key: "working-key" },
  });
  const original = await loadWorkspaceModels(cwd);
  await writeFile(join(workspacePaths(cwd).config, "auth.json"), "broken-json");
  await expect(loadWorkspaceModels(cwd)).rejects.toThrow("Invalid JSON");
  expect((await original.models.getAuth("deepseek"))?.auth.apiKey).toBe(
    "working-key",
  );
});

test("built-in provider overrides keep its catalog and native API while applying headers and output defaults", async () => {
  let received: Record<string, unknown> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received = {
        ...((await request.json()) as Record<string, unknown>),
        header: request.headers.get("x-custom"),
      };
      return new Response(
        'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanups.push(() => server.stop(true));
  const cwd = await directory();
  await json(cwd, "models.json", {
    providers: {
      deepseek: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        headers: { "X-Custom": "yes" },
        modelOverrides: {
          "deepseek-flash": { name: "Overridden", request: { maxTokens: 77 } },
        },
      },
    },
  });
  const { models } = await loadWorkspaceModels(cwd);
  expect(models.getModels("deepseek").length).toBeGreaterThan(1);
  const model = models.getModel("deepseek", "deepseek-flash")!;
  const answer = await models.completeSimple(model, {
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  });
  expect(answer.stopReason).toBe("stop");
  expect(model.name).toBe("Overridden");
  expect(received).toMatchObject({
    model: "deepseek-flash",
    max_tokens: 77,
    header: "yes",
  });
});
