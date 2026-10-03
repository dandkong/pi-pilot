# pi-durable experiment

Branch: `codex/experiment-pi-durable`. Based on pi-pilot `847a0ec` (latest
`origin/main` when the experiment started).

The upstream repository was cloned alongside this checkout at
`D:\Project\Github\Self\pi-upstream`, revision
`4c6fb7cfe8c538a668726f6f8b3554098c39faee`. The implementation uses published
`@earendil-works/pi-durable`, `pi-ai`, and `chord` packages, all pinned to `1.0.1`.
The sibling clone is for investigation; installation does not depend on it.

## What changed

`AgentSessionRuntime`, `AgentSession`, `SessionManager`, `SettingsManager`, and
`ModelRuntime` are replaced with a `Harness`, a durable conversation, and a
pi-ai provider collection. There is no dependency on `pi-coding-agent`.

Each workspace gets a JSONL store under
`PI_PILOT_DATA_DIR/workspaces/<hash-of-workspace-path>`. It uses fsync and durable
task checkpoints. The `pilot.sessions` document records the selected conversation
and the conversations created by `/new`, in the same transaction as their creation.
Workspace switching closes the old store; reopening restores its selected session.

Every Telegram request is admitted directly to the durable inbox, keyed by its
original chat/message IDs. The old in-memory FIFO is removed. Mid-run input uses
`whenBusy: "steer"`; the harness owns admission, ordering, and turn boundaries.
`/stop` aborts the conversation, queued inputs, and its owned background work.
Process shutdown closes storage without aborting tasks. After restart, output is
attached before `resume()` starts unfinished work.

`watchEvents()` provides committed events. `src/pi/events.ts` isolates the chat UI
from the upstream API. Streaming handles both text deltas and full block/message
replacements; a final committed message fills any tail missing from partial output.
Retries and steering boundaries split Telegram message segments. A passive
`pilot.delivery` entry is an output barrier for awaited runner operations, so their
completion includes delivery of the final event batch.

The registry installs `CodingTools` (`read`, `write`, `edit`, `bash`) and the Pilot
system prompt. `NodeExecutionEnv` binds tool execution to the selected workspace.
pi-ai's built-in providers resolve credentials from environment variables or their
native ambient configuration. Models and thinking levels are stored per conversation.
An optional `PI_PILOT_MODEL=provider/model-id` selects a new workspace's initial
model; otherwise the first available model, sorted by provider and name, is selected.
With no credentials, `/models` and `/status` remain available to diagnose setup.

## Compatibility intentionally removed

- Old pi JSONL sessions are not imported. `/resume` lists only durable conversations.
- Old `auth.json`/OAuth login state, `models.json` custom providers, and pi settings
  are not loaded. Set the appropriate provider API key in the bot environment.
- Old pi extension hooks, skills, prompt templates, packages, and automatic resource
  discovery are not loaded. AGENTS.md files are not automatically added to the prompt.
- `/delete` is removed: durable has no conversation deletion API. Histories remain
  in the workspace store.
- `/status` shows the model's context window but reports used context tokens as
  unknown, because the old SDK's estimator is unavailable. Cost is taken from
  durable's usage ledger, including compaction spend.
- Attachments remain local file references. The built-in durable read tool does
  not decode images. Media understanding and survival of temporary attachments
  across an OS reboot are outside this experiment.
- `/reload` reopens the durable store and reinstalls the built-in registry; it does
  not reload old pi resources.

## Validation

`bun run typecheck` and `bun test` check the actual installed durable runtime with
the faux model provider, without Telegram network access or paid model requests.
Integration cases include real read/write/edit/bash tools, streaming, duplicate
Telegram updates, steering, cancellation, sessions/workspaces, persisted model
choices, provider failure recovery, manual compaction, graceful shutdown recovery,
and recovery after forcibly killing a child process.

The durable API is experimental upstream. The version pins keep this branch
reproducible. Use a single bot process per data directory; JSONL storage has a
single writer. This branch is tested locally on Windows with Bun. A live Telegram
bot, a real model provider, and a Docker image build require separate validation.
