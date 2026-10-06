import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { configureLogger } from "../src/logger.ts";
import { PiRunner } from "../src/pi/runner.ts";
import {
  expandSkillPrompt,
  formatWorkspaceResources,
  loadWorkspaceResources,
} from "../src/pi/resources.ts";

configureLogger("silent");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "pilot-resources-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function file(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}
const skillText = (
  name: string,
  description: string,
  body: string,
  extra = "",
) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;

test("resource discovery inherits instructions and skills with predictable overrides and YAML metadata", async () => {
  const root = await directory();
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(cwd);
  const parent = await file(join(root, "AGENTS.md"), "PARENT_RULE");
  const override = await file(join(cwd, "AGENTS.override.md"), "CHILD_RULE");
  await file(join(cwd, "AGENTS.md"), "SHADOWED_RULE");
  await file(
    join(home, ".agents", "skills", "review", "SKILL.md"),
    skillText("review", "User version", "GLOBAL_BODY"),
  );
  await file(
    join(root, ".agents", "skills", "review", "SKILL.md"),
    skillText("review", "Parent version", "PARENT_BODY"),
  );
  await file(
    join(cwd, ".agents", "skills", "review", "SKILL.md"),
    skillText("review", "Project version", "PROJECT_BODY"),
  );
  const privatePath = await file(
    join(cwd, "pi-pilot", "skills", "review", "SKILL.md"),
    skillText(
      "review",
      "|\n  Private <review> & details\n  Second line",
      "PRIVATE_BODY",
    ),
  );
  await file(
    join(cwd, ".agents", "skills", "manual", "SKILL.md"),
    skillText(
      "manual",
      "Explicit only",
      "MANUAL_BODY",
      "disable-model-invocation: true\n",
    ),
  );
  await file(
    join(cwd, ".agents", "skills", "bad", "SKILL.md"),
    "---\ndescription: [broken\n---\nBAD_BODY",
  );
  await file(
    join(cwd, ".agents", "skills", "empty", "SKILL.md"),
    "---\nname: empty\n---\nEMPTY_BODY",
  );
  const resources = await loadWorkspaceResources(cwd, { home });
  expect(resources.instructions.slice(-2).map((file) => file.path)).toEqual([
    parent,
    override,
  ]);
  expect(resources.skills.map((skill) => skill.name)).toEqual([
    "manual",
    "review",
  ]);
  expect(resources.skills.find((skill) => skill.name === "review")?.path).toBe(
    privatePath,
  );
  expect(
    resources.diagnostics.some((item) =>
      item.message.includes("Overrides skill"),
    ),
  ).toBe(true);
  expect(
    resources.diagnostics.filter(
      (item) => item.path.includes("bad") || item.path.includes("empty"),
    ),
  ).toHaveLength(2);
  const prompt = formatWorkspaceResources(resources)!;
  expect(prompt.indexOf("PARENT_RULE")).toBeLessThan(
    prompt.indexOf("CHILD_RULE"),
  );
  expect(prompt).toContain("Private &lt;review&gt; &amp; details");
  expect(prompt).not.toContain("SHADOWED_RULE");
  expect(prompt).not.toContain("PRIVATE_BODY");
  expect(prompt).not.toContain("MANUAL_BODY");
  expect(prompt).not.toContain("Explicit only");
});

test("explicit skill invocation loads its body and paths, and rejects unknown skills", async () => {
  const cwd = await directory();
  const path = await file(
    join(cwd, ".agents", "skills", "manual", "SKILL.md"),
    skillText(
      "manual",
      "Explicit only",
      "Read references/check.md. MANUAL_RULE",
      "disable-model-invocation: true\n",
    ),
  );
  const prompt = await expandSkillPrompt(
    cwd,
    "/skill:manual Check the code\nand tests",
  );
  expect(prompt).toContain("MANUAL_RULE");
  expect(prompt).toContain(dirname(path));
  expect(prompt).toContain("Check the code\nand tests");
  expect(prompt).not.toContain("disable-model-invocation:");
  expect(await expandSkillPrompt(cwd, "Normal request")).toBe("Normal request");
  await expect(expandSkillPrompt(cwd, "/skill:missing task")).rejects.toThrow(
    "Unknown skill: missing",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    loadWorkspaceResources(cwd, { signal: controller.signal }),
  ).rejects.toThrow();
});

test("durable receives resource sections, reads a skill with its native tool, and refreshes resources across turns and workspaces", async () => {
  const root = await directory();
  const cwd = join(root, "project");
  const other = join(root, "other");
  await mkdir(other);
  const agents = await file(join(cwd, "AGENTS.md"), "PROJECT_FIRST_RULE");
  const skill = await file(
    join(cwd, ".agents", "skills", "test-review", "SKILL.md"),
    skillText("test-review", "REVIEW_CATALOG", "REVIEW_BODY"),
  );
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
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
  await runner.init();
  faux.setResponses([
    (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("PROJECT_FIRST_RULE");
      expect(prompt).toContain("REVIEW_CATALOG");
      expect(prompt).not.toContain("REVIEW_BODY");
      return fauxAssistantMessage([fauxToolCall("read", { path: skill })], {
        stopReason: "toolUse",
      });
    },
    (context) => {
      const result = context.messages.find(
        (message) => message.role === "toolResult",
      );
      expect(JSON.stringify(result)).toContain("REVIEW_BODY");
      return fauxAssistantMessage("Reviewed");
    },
  ]);
  await runner.run("Review using test-review");
  const session = (await runner.getStatus()).sessionId;
  await writeFile(agents, "PROJECT_UPDATED_RULE");
  await rm(skill);
  faux.setResponses([
    (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("PROJECT_UPDATED_RULE");
      expect(prompt).not.toContain("PROJECT_FIRST_RULE");
      expect(prompt).not.toContain("REVIEW_CATALOG");
      return fauxAssistantMessage("Updated");
    },
  ]);
  await runner.run("Continue after edits");
  await runner.reload();
  expect((await runner.getStatus()).sessionId).toBe(session);
  await runner.switchWorkspace(1);
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).not.toContain(
        "PROJECT_UPDATED_RULE",
      );
      return fauxAssistantMessage("Other workspace");
    },
  ]);
  await runner.run("Work in the other project");
  await runner.switchWorkspace(0);
  expect((await runner.getStatus()).sessionId).toBe(session);
  await file(
    skill,
    skillText(
      "test-review",
      "REVIEW_CATALOG",
      "EXPLICIT_REVIEW_BODY",
      "disable-model-invocation: true\n",
    ),
  );
  faux.setResponses([
    (context) => {
      expect(
        JSON.stringify(
          context.messages.filter((message) => message.role === "user"),
        ),
      ).toContain("EXPLICIT_REVIEW_BODY");
      expect(getCurrentSystemPrompt(context.messages)).not.toContain(
        "REVIEW_CATALOG",
      );
      return fauxAssistantMessage("Explicit skill");
    },
  ]);
  await runner.run("/skill:test-review Review explicitly");
  expect(
    (await runner.getSkills()).find((skill) => skill.name === "test-review")
      ?.disableModelInvocation,
  ).toBe(true);
});
