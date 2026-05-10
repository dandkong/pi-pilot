# pi-pilot

> Pi in your pocket. Code from anywhere.

A Telegram bot that puts [pi](https://github.com/earendil-works/pi-mono) in your pocket — stream responses, switch models, manage sessions, all from a chat window.

## Features

- **Streaming replies** — watch the agent think and act in real time
- **Model picker** — browse providers and switch models with inline buttons
- **Session management** — resume previous sessions or start fresh ones
- **Message queue** — send multiple requests; they're processed in order
- **Context control** — compact context, abort tasks, check status
- **One-process deployment** — runs on Bun, ships as a single Docker image

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

## Commands

Send `/start` for help, then send a coding request directly. While the agent is running, additional messages are queued and processed in order.

| Command | Description |
|---------|-------------|
| `/status` | Show model, context usage, session stats, active tools |
| `/models` | Browse providers and switch models with inline buttons |
| `/resume` | Resume a previous session (lists 5 most recent) |
| `/new` | Start a new session |
| `/stop` | Abort the running task and clear queued messages |
| `/compact` | Compact conversation context |

## Architecture

```
PiRunner (global)
├── AuthStorage      — API keys, shared across workspaces
├── ModelRegistry    — available models, shared across workspaces
└── Workspace        — cwd-bound session management
    ├── SettingsManager  — per-project preferences
    └── AgentSession     — the active pi session
```

Switching sessions (`/resume`, `/new`) replaces the AgentSession within the current workspace. Future workspace switching would replace the entire Workspace while reusing global resources.

## Storage

- **Chat history** — in memory only, cleared on restart.
- **Pi sessions** — persisted by pi SDK (`~/.pi/agent/sessions/`); in Docker, mount to `/home/bun/.pi/agent`.
- **Pi config/auth** — pi defaults (`~/.pi/agent`); in Docker, mount to `/home/bun/.pi/agent`.
- **Tools** — pi SDK defaults; no explicit tool allowlist.

## License

MIT
