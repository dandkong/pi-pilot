# pi-chat Reference Notes

This project no longer keeps the original `pi-chat/` source tree. Use this document as the local reference when porting features into the Telegram SDK backend.

## Direction

We are not rebuilding pi-chat as a pi extension. This bot is an SDK-based backend:

```text
Telegram -> ChatAdapter -> ChatRuntime -> PiRunner -> pi SDK
```

Keep the current code lightweight. Port features as small modules instead of copying the original monolithic extension.

## Current Architecture

```text
src/
  adapters/
    types.ts          Platform-neutral chat interfaces
    telegram.ts       Telegram long polling, typing, replies, chunking
  runtime/
    chat-runtime.ts   Per-chat in-memory state and dispatch
  pi/
    runner.ts         pi SDK session lifecycle and prompt execution
  config.ts           Minimal app config
index.ts              Startup wiring
```

Current storage policy:

- Chat sessions: in memory only.
- pi config/auth/models/settings: pi defaults, e.g. `~/.pi/agent`.
- Telegram token: env var override, fallback in `src/config.ts` for MVP.

## pi-chat Ideas To Port Later

### 1. Live Adapter Layer

Original idea: isolate chat service details behind a common interface.

Our destination:

- Keep `ChatAdapter` platform-neutral.
- Telegram-specific code stays in `src/adapters/telegram.ts`.
- Future Discord/Slack adapters should implement the same interface.

Useful features to port:

- Bot self-message filtering.
- Group mention trigger detection.
- Reply-to message IDs.
- Media group debouncing.
- Attachment download via Telegram `getFile`.
- File sending via `sendDocument` / `sendPhoto`.
- Streaming preview via `sendMessage` + `editMessageText`.

### 2. Runtime / Job Queue

Original idea: inbound messages are logged, trigger rules decide whether to queue a job, and jobs are dispatched one at a time.

Our destination:

- `ChatRuntime` owns per-chat state.
- Add a per-chat queue instead of rejecting when busy.
- Add trigger policies:
  - DM: every message triggers.
  - Group: only `/ask` or bot mention triggers.
- Build prompt slices from queued messages when useful.

Useful features to port:

- `pendingJobs` / `activeJob` state.
- `stop`, `status`, `compact`, `new` remote commands.
- Failed job handling that does not discard queued input.

### 3. JSONL Chat Log

Original idea: append-only channel log with records like inbound, outbound, checkpoint, job_queued, job_completed, job_failed, error.

Our destination:

```text
data/chats/<chatId>/channel.jsonl
```

Possible record types:

- `inbound`
- `outbound`
- `checkpoint`
- `job_queued`
- `job_completed`
- `job_failed`
- `error`

Use this for:

- Restart recovery.
- Chat history search.
- Debugging.
- Telegram offset persistence.

### 4. Chat History Tool

Original idea: expose older chat log search as a tool.

Our destination:

- Implement a custom pi SDK tool named `chat_history`.
- It searches the JSONL log for the current chat.
- Register it through `customTools` in `PiRunner`.

Tool behavior:

- Params: `query`, `after`, `before`, `limit`.
- Return matching inbound/outbound records as text.
- Include a system reminder that history is reference context only.

### 5. Attachments

Original idea: incoming attachments are materialized to local files; outgoing files are queued via a tool.

Keep the adapter interface platform-neutral. Do not expose Telegram-specific APIs such as `sendPhoto`, `sendDocument`, or `file_id` to runtime code.

Our destination:

```text
data/chats/<chatId>/incoming/
data/chats/<chatId>/outgoing/
```

Suggested inbound shape:

```ts
type ChatAttachmentKind = "image" | "document" | "audio" | "voice" | "video" | "unknown";

type ChatAttachment = {
  id: string;
  kind: ChatAttachmentKind;
  fileName?: string;
  mimeType?: string;
  size?: number;
  platformFileId?: string;
  localPath?: string;
};
```

`ChatMessage` can later grow:

```ts
attachments?: ChatAttachment[];
```

Suggested outbound shape:

```ts
type OutboundAttachment = {
  kind?: ChatAttachmentKind;
  path: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
};
```

The adapter can later expose:

```ts
sendAttachments(chatId, attachments, options?)
```

Port in two pieces:

- Incoming: Telegram adapter downloads files and adds local paths to `ChatMessage.attachments`.
- Outgoing: custom tool `chat_attach(paths)` queues files; runtime sends them after the agent response.

Telegram methods:

- Download: `getFile` then `https://api.telegram.org/file/bot<TOKEN>/<file_path>`.
- Send: adapter maps kind to `sendPhoto`, `sendDocument`, `sendAudio`, `sendVoice`, or `sendVideo`.

### 6. Memory

Original idea: persistent memory files are injected into the prompt every turn.

Our destination options:

- Global memory: `MEMORY.md`.
- Per-chat memory: `data/chats/<chatId>/memory.md`.
- Shared/account memory can be added later if multi-account support matters.

Prompt rule:

- Save durable facts/preferences only.
- Do not save transient task details.
- Ask before storing sensitive or cross-chat information.

### 7. Skills and pi Packages

Original idea: skills and package resources are discovered and injected into the agent environment.

Our destination:

- Use pi SDK `DefaultResourceLoader` in `PiRunner`.
- Keep `cwd` and `agentDir` configurable later.
- Let pi load packages from default global/project settings.

Important detail:

- If `tools` is an allowlist, package-provided tools may be blocked.
- Add config later: `toolMode: "builtin" | "all" | "allowlist"`.

### 8. Remote Control Commands

Implement first because they are high value and small:

```text
/status   Show cwd, model, tools, chat count, busy state.
/compact  Call PiRunner.compact() for current chat.
/new      Dispose current runner and create a fresh in-memory session.
/stop     Call PiRunner.abort() for current chat.
```

These belong in `ChatRuntime`, not the Telegram adapter.

### 9. Secrets

Original idea: encrypted secret exchange through a browser widget.

Our destination, later:

- Custom tool `chat_request_secret`.
- Bot sends a one-time request link or asks user to paste encrypted blob.
- Store decrypted result under a per-chat secret directory.

Do not implement until core bot behavior is stable.

### 10. Sandboxing

Original pi-chat used Gondolin/QEMU per channel.

Our destination:

- Docker is the primary sandbox.
- Prefer mounting a controlled `/workspace` instead of host root.
- Later config can support `PI_BOT_CWD=/workspace`.
- Dangerous tool confirmation can be added in runtime/tool policy.

## Suggested Feature Order

1. `/status`, `/compact`, `/new`, `/stop`.
2. `PI_BOT_CWD` and Docker `/workspace` support.
3. Allowed chat IDs.
4. `DefaultResourceLoader` / pi package loading in `PiRunner`.
5. Telegram attachments in.
6. `chat_attach` attachments out.
7. JSONL chat log.
8. `chat_history` custom tool.
9. Memory.
10. Streaming preview.
11. Secrets exchange.

## Things Not To Port Directly

- TUI setup flows.
- tmux worker orchestration.
- Gondolin VM lifecycle.
- Discord code until Telegram is stable.
- Original extension event handlers; use SDK events and runtime methods instead.

## Implementation Rule

When porting a feature, place it in the right layer:

- Telegram API details -> `src/adapters/telegram.ts`.
- Platform-neutral message shape -> `src/adapters/types.ts`.
- Commands, queues, permissions -> `src/runtime/chat-runtime.ts`.
- pi SDK, tools, packages, model/session behavior -> `src/pi/runner.ts`.
- Shared persistence helpers -> new files under `src/runtime/` or `src/storage/`.
