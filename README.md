# pi-pilot

Minimal Telegram backend powered by the pi SDK.

## Run

Create a local `.env` file:

```env
TELEGRAM_BOT_TOKEN="123456:your-token"
```

Then run:

```bash
bun run start
```

Bun loads `.env` automatically. `.env` is ignored by git; use `.env.example` as the template.

Set `PI_PILOT_CWD` to choose the agent working directory. It defaults to the process cwd when unset.

## Docker

Build the image:

```bash
docker build -t pi-pilot .
```

Run with Docker Compose:

```bash
cp .env.example .env
# Edit TELEGRAM_BOT_TOKEN.
docker compose up --build
```

Or run directly with Docker:

```bash
docker run --rm \
  --env TELEGRAM_BOT_TOKEN="123456:your-token" \
  --env PI_PILOT_CWD=/workspace \
  --volume "$PWD:/workspace" \
  --volume "$HOME/.pi/agent:/home/bun/.pi/agent" \
  pi-pilot
```

In Docker, the bot code lives in `/app` and the default agent workspace is `/workspace`. Compose mounts this repository to `/workspace`; for another project, use `docker run --volume /path/to/project:/workspace` or edit the Compose volume.

## Current Architecture

- `src/adapters/telegram.ts` - Telegram adapter built on grammY: long polling, typing, draft streaming, replies, message chunking.
- `src/runtime/chat-runtime.ts` - Per-chat in-memory state, FIFO message queue, and request dispatch.
- `src/pi/runner.ts` - pi SDK session creation and prompt execution.
- `src/config.ts` - app config, including `PI_PILOT_CWD` working directory support.

## Storage

- Chat history: in memory only, cleared on restart.
- Pi config/auth/models/settings: pi defaults, for example `~/.pi/agent`; in Docker, mount this to `/home/bun/.pi/agent`.
- Tools: pi SDK defaults; this app does not pass an explicit tool allowlist.

## Usage

Send `/start` for help, then send a coding request directly. While the agent is running, additional messages are queued and processed in order.

Commands:

- `/status` - Show current model, thinking level, context usage, cwd, session stats, and active tool count.
- `/models` - Open an inline model picker: provider list first, then all available models for that provider.
- `/stop` - Abort the current running task and clear queued messages.
- `/compact` - Compact the conversation context.
