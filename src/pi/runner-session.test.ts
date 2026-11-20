import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRunner } from "./runner.ts";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-pilot-test-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "work"));
});
afterAll(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

test("remembers the selected session instead of the latest external session", async () => {
  const cwd = join(root, "work");
  const config = { telegramToken: "test", workspaces: [cwd], allowedActorIds: [], toolDisplayMode: "never" as const, logLevel: "silent" as const };
  const external = SessionManager.create(cwd);
  external.appendMessage({ role: "user", content: [{ type: "text", text: "existing conversation" }], timestamp: Date.now() });
  const runner = new PiRunner(config);
  try {
    await runner.init();
    expect((await runner.getStatus()).sessionId).not.toBe(external.getSessionId());
    const index = (await runner.listSessions()).findIndex((session) => session.id === external.getSessionId());
    expect(index).toBeGreaterThanOrEqual(0);
    await runner.switchSession(index);
    const statePath = join(root, "agent", "pi-pilot.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.sessions[cwd]).toBe(external.getSessionFile());
    state.other = { keep: true };
    await writeFile(statePath, JSON.stringify(state));
    const newer = SessionManager.create(cwd);
    newer.appendMessage({ role: "user", content: [{ type: "text", text: "another external conversation" }], timestamp: Date.now() });
    await runner.reload();
    expect((await runner.getStatus()).sessionId).toBe(external.getSessionId());
    expect(JSON.parse(await readFile(statePath, "utf8")).other).toEqual({ keep: true });
    await rm(external.getSessionFile()!);
    await runner.reload();
    expect((await runner.getStatus()).sessionId).not.toBe(newer.getSessionId());
  } finally {
    await runner.dispose();
  }
});
