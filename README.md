# pi-pilot

> Pi in your pocket. Create from anywhere.

This experimental branch runs pi-pilot on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 1.0.1. It uses durable conversations and coding tools directly from Telegram. See [the experiment notes](docs/durable-experiment.md) for the architecture and compatibility changes.

## Features

- Stream replies and tool activity back to chat
- Switch workspaces, models, and recent sessions
- Persist conversations, inboxes, and unfinished tasks across process restarts
- Use built-in read, write, edit, and bash tools
- Docker deployment support

## Prerequisites

Install Bun and configure a model provider API key, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. A pi CLI installation is no longer required. Windows bash tool execution requires Git Bash (or another bash on PATH).

Old pi credentials, settings, custom models, sessions, extensions, skills, and prompt templates are not loaded. This branch creates separate data under `~/.pi/pilot/durable` by default. Override it with `PI_PILOT_DATA_DIR` and persist that directory in Docker. The first available model is selected for a new workspace; set `PI_PILOT_MODEL=provider/model-id` to choose one explicitly.

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Show model, context window, session, queue, tools, and cost |
| `/compact` | Compact conversation context |
| `/models` | Choose a model with inline buttons |
| `/thinking` | Set thinking level for the current model |
| `/workspaces` | Switch between configured project directories |
| `/new` | Start a fresh session |
| `/stop` | Abort the running task and clear queued messages |
| `/resume` | Resume one of the 5 most recent sessions |
| `/recent` | Show the last few messages of the current session |
| `/reload` | Reopen the current durable session |
| `/help` | List available commands |
| `/start` | Welcome message and quick start hint |
| `/exit` | Exit the pi-pilot process |

This order is the source of truth for the Telegram command menu and `/help` output; it comes from `CHAT_COMMANDS` in `src/runtime/chat-commands.ts`.

## Run from Source

Create `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
TELEGRAM_DEFAULT_CHAT_ID=123456789
PI_PILOT_WORKSPACES=/path/to/project,/path/to/other-project
PI_PILOT_LOG_LEVEL=info
ANTHROPIC_API_KEY=your-provider-key
# Optional: PI_PILOT_MODEL=provider/model-id
# Optional: PI_PILOT_DATA_DIR=/path/to/persistent-data
```

Install and start from this repository:

```bash
bun install
bun run start
```

## CLI

For local development, link this repository as a command:

```bash
bun link
pi-pilot --help
```

Run with CLI options:

```bash
pi-pilot \
  --telegram-token 123456:your-token \
  --allowed-users 123456789 \
  --default-chat-id 123456789 \
  --workspaces /path/to/project,/path/to/other-project \
  --log-level info
```

Available options:

| Option | Environment Variable | Description |
|--------|----------------------|-------------|
| `--telegram-token`, `--bot-token` | `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `--workspaces` | `PI_PILOT_WORKSPACES` | Comma-separated workspace paths |
| `--allowed-users` | `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs allowed to interact |
| `--default-chat-id` | `TELEGRAM_DEFAULT_CHAT_ID` | Default Telegram chat ID for all bot output |
| `--log-level` | `PI_PILOT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |
| `--model` | `PI_PILOT_MODEL` | Initial model for new workspaces (`provider/model-id`) |
| `--data-dir` | `PI_PILOT_DATA_DIR` | Durable storage directory (default: `~/.pi/pilot/durable`) |

## Docker

Build this experimental branch locally; the published `latest` image tracks main.
Set the Telegram credentials and your provider API key in `.env`, then run:

```bash
cp .env.example .env
docker compose up --build
```

The included compose file mounts the project at `/workspace` and stores durable
state in the `pilot-durable` named volume. `PI_PILOT_DATA_DIR` inside the container
is `/home/bun/.pi/pilot/durable`. A container restart resumes unfinished work.

To build only the image:

```bash
docker build -t pi-pilot:durable .
```

## Workspaces

If `PI_PILOT_WORKSPACES` is set, the first path is the default workspace and `/workspaces` can switch between the listed directories:

```env
PI_PILOT_WORKSPACES=/workspace/project-a,/workspace/project-b
```

If `PI_PILOT_WORKSPACES` is not set, pi-pilot uses the directory where the process starts. In Docker, set `working_dir` to the mounted workspace or set `PI_PILOT_WORKSPACES` explicitly.

## Access Control

Set `TELEGRAM_ALLOWED_USERS` to a comma-separated list of Telegram user IDs allowed to interact:

```env
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

Leave it empty to deny all users. User IDs are logged when unauthorized users are rejected.

## Default Output Chat

Set `TELEGRAM_DEFAULT_CHAT_ID` to route bot output to one private chat, group, or supergroup:

```env
TELEGRAM_DEFAULT_CHAT_ID=123456789
```

For groups or supergroups, use the group chat ID, which is often negative or starts with `-100`. If unset, pi-pilot falls back to the first `TELEGRAM_ALLOWED_USERS` entry for personal private-chat setups. If both are empty, bot output has no default target and Telegram users are rejected.

## License

MIT
