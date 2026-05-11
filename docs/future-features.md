# Future Features

This document tracks ideas that could make pi-pilot more useful as a portable coding assistant. It is not a commitment to implement everything.

## High Value

### `/changes`

Show the current workspace changes from Telegram.

Possible output:

- `git status --short`
- changed file list
- optional compact diff summary

This should be read-only and safe to run anytime.

### `/commit`

Commit current workspace changes from Telegram.

Suggested flow:

1. Show changed files.
2. Generate or ask for a commit message.
3. Require an inline confirmation button.
4. Run `git commit` only after confirmation.

Do not push automatically. Keep `/push` separate if added later.

### Attachments

Support files and images in both directions.

Inbound:

- User sends screenshots, logs, patches, or source files.
- Telegram adapter downloads them to a workspace or chat-specific temp directory.
- Runtime passes local paths to pi.

Outbound:

- Add a tool or runtime helper for sending generated files back to Telegram.
- Prefer documents for long diffs/logs instead of splitting many messages.

### Health / Version

Add `/health` for operational checks.

Useful fields:

- uptime
- current workspace
- current session id
- app version or git commit sha
- Docker image build time if available

## Medium Value

### Chat Log

Persist platform-level chat events as JSONL.

Possible path:

```text
data/chats/<chatId>/channel.jsonl
```

Possible records:

- inbound message
- outbound message
- job queued
- job completed
- job failed
- command executed

This would help with restart recovery, debugging, and future history search.

### `chat_history` Tool

Expose the persisted chat log to pi as a read-only custom tool.

Possible params:

- `query`
- `after`
- `before`
- `limit`

Keep it scoped to the current chat unless there is a clear reason to search globally.

### Memory

Store durable preferences and facts.

Possible files:

- global memory: `MEMORY.md`
- per-chat memory: `data/chats/<chatId>/memory.md`

Rules:

- Save durable preferences only.
- Avoid transient task details.
- Ask before storing sensitive information.

### Group Chat Policy

If the bot is used in groups, add stricter trigger rules.

Examples:

- direct messages: every message triggers
- group chats: only `/ask`, replies to the bot, or `@botname` mentions trigger

This avoids accidental task execution in group conversations.

## Safety

### Dangerous Action Confirmation

Require confirmation for high-risk actions initiated by commands.

Examples:

- `/push`
- `/deploy`
- destructive git operations
- file deletion helpers
- service restart helpers

For normal pi tool usage, rely on Telegram user allowlist and Docker workspace isolation unless a stronger policy is needed.

### Workspace Guardrails

Current workspace switching should remain config-based.

Keep these constraints:

- no arbitrary path input from Telegram
- only configured, mounted directories can be selected
- do not switch workspace while a task, queue, stream, or compaction is active

## Lower Priority

### Secret Request Flow

A future tool could request a one-time secret from the user, but this is intentionally lower priority because it is easy to get wrong.

Avoid storing secrets unless there is a clear lifecycle and deletion story.

### Additional Chat Platforms

The adapter layer can support other platforms later, such as Discord or Slack.

Do this only after the Telegram backend is stable.

## Current Baseline

Already implemented:

- Telegram adapter
- streaming replies
- per-chat queue
- `/status`, `/models`, `/resume`, `/new`, `/stop`, `/compact`, `/workspaces`
- session persistence and resume
- workspace switching via configured paths
- Telegram user allowlist
- Docker image publishing
