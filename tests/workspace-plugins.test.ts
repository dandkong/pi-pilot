import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import { workspacePaths } from "../src/config/paths.ts";
import { PiRunner } from "../src/pi/runner.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function file(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pilot plugins #test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const other = join(root, "other");
  await mkdir(cwd);
  await mkdir(other);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const createRunner = () => {
    const runner = new PiRunner(
      {
        telegramToken: "test",
        workspaces: [cwd, other],
        allowedActorIds: ["1"],
        logLevel: "silent",
      },
      { models },
    );
    cleanups.push(() => runner.dispose());
    return runner;
  };
  return { root, cwd, other, faux, createRunner, runner: createRunner() };
}

const pluginSource = String.raw`
import { Type } from "typebox";
import { Type as PiType } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { label, helperPath } from "./lib/helper.ts";
const State = defineDoc<{ value: string }>({ kind: "test.plugin-value", version: 1, scope: "conversation", initial: () => ({ value: "" }) });
export default defineExtension({
  name: "test-state",
  tools: [defineTool({
    name: "plugin_store", description: "Remember a test value", parameters: Type.Object({ value: Type.String() }),
    execute: async (args, api, context) => {
      if (Type !== PiType) throw new Error("Plugin must share host TypeBox");
      await api.commit(async tx => { (await tx.doc(State, api.conversationId)).value = args.value; }, context);
      const asset = await readFile(join(import.meta.dir, "asset.txt"), "utf8");
      return { content: [{ type: "text", text: label + ":" + asset + ":" + helperPath + ":" + import.meta.url }] };
    },
  })],
  sections: [section("plugin_state", async input => {
    const state = await input.read.snapshot(State, input.conversationId, BACKGROUND_CONTEXT);
    return label + ":" + (state?.value ?? "empty");
  })],
});`;

test("workspace plugins resolve host dependencies, execute tools, persist documents and preserve source-relative assets", async () => {
  const { cwd, faux, runner, createRunner } = await fixture();
  const folder = join(workspacePaths(cwd).extensions, "state");
  await file(join(folder, "index.ts"), pluginSource);
  await file(
    join(folder, "lib", "helper.ts"),
    'export const label = "PLUGIN_V1"; export const helperPath = import.meta.dir;',
  );
  await file(join(folder, "asset.txt"), "ASSET");
  await file(
    join(workspacePaths(cwd).extensions, "a-prompt.js"),
    'export default { name: "a-prompt", sections: [{ key: "a_prompt", render: () => "FILE_PLUGIN" }] };',
  );
  await file(
    join(workspacePaths(cwd).extensions, ".disabled.ts"),
    "this is disabled invalid syntax",
  );
  await runner.init();
  expect(workspacePaths(cwd).root).toBe(join(cwd, ".pi-pilot"));
  expect((await runner.getPlugins()).map((plugin) => plugin.name)).toEqual([
    "a-prompt",
    "test-state",
  ]);
  expect((await runner.getStatus()).activeTools).toContain("plugin_store");
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("FILE_PLUGIN");
      return fauxAssistantMessage(
        fauxToolCall("plugin_store", { value: "KEPT_VALUE" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = JSON.stringify(
        context.messages.find((message) => message.role === "toolResult"),
      );
      expect(result).toContain("PLUGIN_V1:ASSET");
      expect(result).toContain(
        JSON.stringify(join(folder, "lib")).slice(1, -1),
      );
      expect(result).toContain("index.ts");
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "PLUGIN_V1:KEPT_VALUE",
      );
      return fauxAssistantMessage("Stored");
    },
  ]);
  await runner.run("Store a value");
  const session = (await runner.getStatus()).sessionId;
  await file(
    join(folder, "lib", "helper.ts"),
    'export const label = "PLUGIN_V2"; export const helperPath = import.meta.dir;',
  );
  await runner.reload();
  expect((await runner.getStatus()).sessionId).toBe(session);
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "PLUGIN_V2:KEPT_VALUE",
      );
      expect(getCurrentSystemPrompt(context.messages)).not.toContain(
        "PLUGIN_V1",
      );
      return fauxAssistantMessage("Reloaded");
    },
  ]);
  await runner.run("Continue after helper changes");
  expect(
    (await readdir(workspacePaths(cwd).tmp)).filter((name) =>
      name.startsWith("extensions-"),
    ),
  ).toHaveLength(1);
  await runner.dispose();
  expect(
    (await readdir(workspacePaths(cwd).tmp)).filter((name) =>
      name.startsWith("extensions-"),
    ),
  ).toHaveLength(0);
  const restarted = createRunner();
  await restarted.init();
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "PLUGIN_V2:KEPT_VALUE",
      );
      return fauxAssistantMessage("Recovered state");
    },
  ]);
  await restarted.run("Continue after restart");
});

test("invalid plugin reload and workspace selection preserve the active runtime and clean failed builds", async () => {
  const { cwd, other, faux, runner } = await fixture();
  const path = join(workspacePaths(cwd).extensions, "healthy.ts");
  await file(
    path,
    'export default { name: "healthy", sections: [{ key: "healthy", render: () => "HEALTHY_PLUGIN" }] };',
  );
  await runner.init();
  const session = (await runner.getStatus()).sessionId;
  const cases = [
    "export default {", // Compile failure.
    'throw new Error("Import failed"); export default { name: "broken" };',
    'export default () => ({ name: "old-factory" });',
    'export default { name: "pilot" };', // Built-in extension name.
    'export default { name: "broken", tools: [{ name: "bad" }] };',
    'export default { name: "broken", sections: [{ key: "instructions", render: () => "reserved" }] };',
  ];
  for (const source of cases) {
    await file(path, source);
    await expect(runner.reload()).rejects.toThrow();
    expect((await runner.getStatus()).sessionId).toBe(session);
    expect((await runner.getPlugins()).map((plugin) => plugin.name)).toEqual([
      "healthy",
    ]);
    expect(
      (await readdir(workspacePaths(cwd).tmp)).filter((name) =>
        name.startsWith("extensions-"),
      ),
    ).toHaveLength(1);
  }
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "HEALTHY_PLUGIN",
      );
      return fauxAssistantMessage("Previous plugin still works");
    },
  ]);
  await runner.run("Continue after invalid edits");
  await file(path, 'export default { name: "healthy" };');
  const duplicate = join(workspacePaths(cwd).extensions, "duplicate.ts");
  await file(duplicate, 'export default { name: "healthy" };');
  await expect(runner.reload()).rejects.toThrow("Duplicate");
  await rm(duplicate);
  await file(
    join(workspacePaths(other).extensions, "broken.ts"),
    "export default null;",
  );
  await expect(runner.switchWorkspace(1)).rejects.toThrow("default export");
  expect(runner.getWorkspaceDirectory()).toBe(cwd);
  await expect(access(workspacePaths(other).sessions)).rejects.toThrow();
});

test("plugin addition, removal and workspace switching update tools and prompt sections without changing conversations", async () => {
  const { cwd, other, faux, runner } = await fixture();
  await runner.init();
  const session = (await runner.getStatus()).sessionId;
  const path = join(workspacePaths(cwd).extensions, "new.mjs");
  await file(
    path,
    'export default { name: "new", tools: [{ name: "new_tool", description: "Example", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "NEW_TOOL" }] }) }], sections: [{ key: "new_section", render: () => "NEW_PLUGIN_SECTION" }] };',
  );
  await runner.reload();
  expect((await runner.getStatus()).sessionId).toBe(session);
  faux.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages).map((tool) => tool.name),
      ).toContain("new_tool");
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "NEW_PLUGIN_SECTION",
      );
      return fauxAssistantMessage("Plugin added");
    },
  ]);
  await runner.run("Check new plugin");
  await runner.switchWorkspace(1);
  expect(await runner.getPlugins()).toEqual([]);
  expect((await runner.getStatus()).activeTools).not.toContain("new_tool");
  await runner.switchWorkspace(0);
  expect((await runner.getStatus()).sessionId).toBe(session);
  await rm(path);
  await runner.reload();
  faux.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages).map((tool) => tool.name),
      ).not.toContain("new_tool");
      expect(getCurrentSystemPrompt(context.messages)).not.toContain(
        "NEW_PLUGIN_SECTION",
      );
      return fauxAssistantMessage("Plugin removed");
    },
  ]);
  await runner.run("Check removal");
  expect(await runner.getPlugins()).toEqual([]);
});
