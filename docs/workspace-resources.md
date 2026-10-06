# Workspace instructions, skills, and extensions

The interoperability directory is **`.agents/skills`** (plural), and the
instruction file is **`AGENTS.md`**. These are application resources, rather than
formats automatically loaded by pi-durable. Pilot provides their file contents
and catalog metadata without a built-in role/personality or behavior prompt.
Put behavioral instructions in AGENTS.md, skills, or a workspace plugin.

## Instructions

Before every model request, Pilot reads instruction files from the filesystem
root down to the conversation's working directory. A directory's
`AGENTS.override.md`, when present, replaces its `AGENTS.md`. Ancestor files are
included before child files, with closer instructions taking precedence.

For the test workspace, `D:/Project/workspace/AGENTS.md` is inherited by
`D:/Project/workspace/pi-pilot-durable`. You can add an `AGENTS.md` directly in
the test workspace for more specific rules. Empty files are omitted; an empty
override still suppresses that directory's ordinary AGENTS.md.

Files below the working directory are not automatically scanned. There is no
built-in instruction telling the model to discover them; put any such workflow
in your own AGENTS.md. Switching workspaces changes the loaded resources.

## Skills

Skills are scanned in this precedence order, with later locations overriding the
same skill name:

1. `~/.agents/skills/` for user-wide skills.
2. `.agents/skills/` in ancestor directories, from filesystem root down to cwd.
3. `<workspace>/.pi-pilot/skills/` for workspace-private skills.

For example:

```text
D:/Project/workspace/pi-pilot-durable/
├── AGENTS.md
├── .agents/skills/
│   └── review/
│       ├── SKILL.md
│       └── references/checklist.md
└── .pi-pilot/
    ├── config/
    ├── sessions/
    └── skills/
        └── personal-task/SKILL.md
```

An interoperable skill can be versioned with the project under `.agents/skills`.
Workspace-private skills live in the ignored `.pi-pilot` data directory. Existing
`.pi/skills` directories are not loaded; place the desired skills in one of the
locations above.

```markdown
---
name: review
description: Review code changes and identify missing verification.
---

Read the relevant code and tests. Use references/checklist.md as the review guide.
```

Only names, descriptions, and absolute SKILL.md paths enter the system prompt.
The model can use the native `read` tool to load skill bodies. The application does
not inject an instruction to automatically select/read them; define that behavior
in AGENTS.md or a plugin. Explicit invocation supplies the skill file path and
base directory as metadata, along with its body and the user's task.
This follows the [Agent Skills integration convention](https://agentskills.io/client-implementation/adding-skills-support).

`/skills` lists available skills. Send `/skill:review Check the current changes`
to explicitly load a skill's body into the durable input. Skills with YAML
`disable-model-invocation: true` are omitted from automatic discovery in the
prompt, but remain available through `/skills` and explicit invocation. When no
task text accompanies the invocation, only the requested skill content is supplied.

YAML block descriptions and linked skill directories are supported. Malformed
skills are skipped with a diagnostic; duplicate names use the precedence above.
Discovery skips hidden child directories and node_modules, stops at depth 6 and
2000 directories, and prevents symlink cycles. Nested collection directories are
scanned, but a skill's own scripts/assets are not scanned as separate skills.

Resource changes appear on the next model request without `/reload`. Durable
records changed prompt sections and removes obsolete ones. Stable resources do
not add a new section delta on every request; after compaction the current
instructions and catalog are rendered again. Skill bodies read during a run are
ordinary conversation context and may be summarized during compaction; a model
can reread them from their catalog paths. There is no separate persistent record
of activated skills yet.

## Durable extensions

The old coding-agent extension factory and `ExtensionAPI` are not compatible
with durable. Pilot does not load old `.pi/extensions` or package manifests.
The host installs named extension objects in its registry:

```typescript
import {
  createRegistry,
  defineExtension,
  section,
} from "@earendil-works/pi-durable";

const ProjectRules = defineExtension({
  name: "project-rules",
  sections: [
    section("project_rules", () => "Verify changes before completing a task."),
  ],
});

const registry = createRegistry();
registry.install(ProjectRules);
```

An extension can provide:

| Field      | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| `tools`    | TypeBox arguments and tool execution through the durable tool API   |
| `sections` | System prompt sections rendered before requests                     |
| `hooks`    | Hooks on durable task phases, such as generation and tool execution |
| `wraps`    | Decorators that replace or adjust a selected tool or section        |
| `tasks`    | Custom durable task definitions with recovery support               |

Structured persistent state is defined separately with `defineDoc()` and read or
updated through durable's document/transaction APIs. The registry stores code in
memory; conversations persist extension names. Reinstalling an extension with the
same name replaces its code for subsequent phases. After a process restart, the
host must install its extensions again for pending custom tasks to resume.

Pilot automatically loads workspace plugins from `.pi-pilot/extensions` in addition
to the built-ins in `src/pi/harness.ts`. Entries are `.ts`, `.js`, or `.mjs` files,
or directories with an `index.ts`, `index.js`, or `index.mjs`; each defaults to an
Extension object. `/plugins` lists the active plugins and `/reload` validates and
reloads their code. See [workspace plugins](workspace-plugins.md) for examples.
Telegram commands and UI remain in the application layer (`ChatCommands`), rather
than being registered through the old CLI/TUI extension API.

See the [upstream durable extension documentation](https://github.com/earendil-works/pi/tree/main/packages/durable#extensions)
for task hooks, documents, and per-conversation extension selection.
