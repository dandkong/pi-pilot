import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { logger } from "../logger.ts";
import { workspacePaths } from "../config/paths.ts";

export type WorkspaceSkill = {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
};
export type WorkspaceResources = {
  instructions: { path: string; content: string }[];
  skills: WorkspaceSkill[];
  diagnostics: { path: string; message: string }[];
};

function ancestors(cwd: string): string[] {
  const result = [resolve(cwd)];
  while (dirname(result[0]!) !== result[0]) result.unshift(dirname(result[0]!));
  return result;
}

function frontmatter(text: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Missing YAML frontmatter");
  const metadata: unknown = Bun.YAML.parse(match[1]!);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Frontmatter must be an object");
  return {
    metadata: metadata as Record<string, unknown>,
    body: normalized.slice(match[0].length).trim(),
  };
}

/** Files remain application resources; durable persists the rendered prompt changes. */
export async function loadWorkspaceResources(
  cwd: string,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceResources> {
  const result: WorkspaceResources = {
    instructions: [],
    skills: [],
    diagnostics: [],
  };
  const warn = (path: string, message: string) =>
    result.diagnostics.push({ path, message });
  const read = async (path: string): Promise<string | undefined> => {
    options.signal?.throwIfAborted();
    try {
      return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(path, "Cannot read resource file");
      return undefined;
    }
  };
  const directories = ancestors(cwd);
  for (const directory of directories) {
    // One instruction file per scope, with the explicit override taking precedence.
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const path = join(directory, name);
      const content = await read(path);
      if (content !== undefined) {
        if (content.trim()) result.instructions.push({ path, content });
        break;
      }
    }
  }

  const byName = new Map<string, WorkspaceSkill>();
  const roots = [
    join(options.home ?? homedir(), ".agents", "skills"),
    ...directories.map((directory) => join(directory, ".agents", "skills")),
    join(workspacePaths(cwd).root, "skills"),
  ];
  const seenRoots = new Set<string>();
  let visitedCount = 0;
  for (const root of roots) {
    options.signal?.throwIfAborted();
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(root, "Cannot access skills directory");
      continue;
    }
    if (seenRoots.has(canonical)) continue;
    seenRoots.add(canonical);
    const seenDirectories = new Set<string>();
    const scan = async (directory: string, depth: number): Promise<void> => {
      options.signal?.throwIfAborted();
      if (depth > 6 || visitedCount >= 2000) {
        warn(directory, "Skill discovery limit reached");
        return;
      }
      try {
        const real = await realpath(directory);
        if (seenDirectories.has(real)) return; // Linked skill collections may contain cycles.
        seenDirectories.add(real);
        visitedCount++;
        const entries = await readdir(directory, { withFileTypes: true });
        const path = join(directory, "SKILL.md");
        if (entries.some((entry) => entry.name === "SKILL.md")) {
          const text = await read(path);
          if (text !== undefined) {
            try {
              const { metadata } = frontmatter(text);
              const description =
                typeof metadata.description === "string"
                  ? metadata.description.trim()
                  : "";
              const name =
                typeof metadata.name === "string"
                  ? metadata.name.trim()
                  : basename(directory);
              if (!name || !description) {
                warn(path, "Skill requires a name and description");
              } else {
                if (name !== basename(directory))
                  warn(path, "Skill name differs from directory name");
                const previous = byName.get(name);
                if (previous) warn(path, `Overrides skill at ${previous.path}`);
                byName.set(name, {
                  name,
                  description,
                  path,
                  disableModelInvocation:
                    metadata["disable-model-invocation"] === true,
                });
              }
            } catch {
              // YAML parser errors can include file contents. Keep diagnostics scoped to the path.
              warn(path, "Invalid skill YAML frontmatter");
            }
          }
          return; // Supporting resources inside a skill are loaded on demand.
        }
        for (const entry of entries.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const child = join(directory, entry.name);
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              isDirectory = (await stat(child)).isDirectory();
            } catch {
              warn(child, "Cannot access linked skill directory");
              continue;
            }
          }
          if (isDirectory) await scan(child, depth + 1);
          if (visitedCount >= 2000) break;
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        warn(directory, "Cannot scan skills directory");
      }
    };
    await scan(root, 0);
  }
  options.signal?.throwIfAborted();
  result.skills = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return result;
}

const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function formatWorkspaceResources(
  resources: WorkspaceResources,
): string | undefined {
  const parts: string[] = [];
  if (resources.instructions.length) {
    parts.push(
      "Apply these AGENTS.md instructions in order; instructions closer to the working directory take precedence. Before modifying files in a child directory, check for additional AGENTS.md instructions there.",
    );
    for (const file of resources.instructions)
      parts.push(
        `<instructions_file path="${escapeXml(file.path)}">\n${file.content}\n</instructions_file>`,
      );
  }
  const visible = resources.skills.filter(
    (skill) => !skill.disableModelInvocation,
  );
  if (visible.length) {
    parts.push(
      "When a task matches a skill, read its SKILL.md using the read tool before proceeding. Only the catalog is loaded here. Resolve relative references against the skill's directory and load supporting files as needed. When the user explicitly names a skill, read it first.",
    );
    parts.push(
      `<available_skills>\n${visible.map((skill) => `  <skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.path)}</location></skill>`).join("\n")}\n</available_skills>`,
    );
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

export function createWorkspaceResourcesExtension(cwd: string) {
  const reported = new Set<string>();
  return defineExtension({
    name: "pilot-resources",
    sections: [
      section("workspace_resources", async (input, context) => {
        const resources = await loadWorkspaceResources(input.env?.cwd ?? cwd, {
          signal: context.abortSignal,
        });
        for (const diagnostic of resources.diagnostics) {
          const key = `${diagnostic.path}:${diagnostic.message}`;
          if (!reported.has(key)) {
            reported.add(key);
            logger.warn("Workspace resource warning", diagnostic);
          }
        }
        return formatWorkspaceResources(resources);
      }),
    ],
  });
}

/** Explicit invocation also permits skills hidden from automatic model discovery. */
export async function expandSkillPrompt(
  cwd: string,
  prompt: string,
): Promise<string> {
  const match = prompt.trim().match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return prompt;
  const resources = await loadWorkspaceResources(cwd);
  const skill = resources.skills.find((skill) => skill.name === match[1]);
  if (!skill)
    throw new Error(
      `Unknown skill: ${match[1]}. Use /skills to list available skills.`,
    );
  const { body } = frontmatter(await readFile(skill.path, "utf8"));
  return `Use the explicitly requested skill ${skill.name}. Resolve relative paths against ${dirname(skill.path)}.\n\n<requested_skill path="${escapeXml(skill.path)}">\n${body}\n</requested_skill>\n\n${match[2] ?? "Follow this skill's instructions."}`;
}
