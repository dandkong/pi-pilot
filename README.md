# pi-pilot

> Pi in your pocket. Create from anywhere.

This experimental branch runs pi-pilot on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 1.0.1. It uses durable conversations and coding tools directly from Telegram. See [the experiment notes](docs/durable-experiment.md) for the architecture and compatibility changes.

## Features

- Stream replies and tool activity back to chat
- Switch workspaces, models, and recent sessions
- Configure custom providers and model profiles with workspace JSON files
- Persist conversations, inboxes, and unfinished tasks across process restarts
- Use built-in read, write, edit, and bash tools
- Inherit AGENTS.md instructions and discover Agent Skills in `.agents/skills`
- Docker deployment support

## Prerequisites

Install Bun and configure a model provider API key, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. A pi CLI installation is no longer required. Windows bash tool execution requires Git Bash (or another bash on PATH).

All persistent data lives under `<workspace>/pi-pilot/`: `config`, `sessions`, and `attachments`. Downloads use `tmp`; exports and file logs are reserved for future features. There is no central data directory or workspace-path hash. Old sessions and global pi configuration are not imported. AGENTS.md and skills are supported; old coding-agent plugins and prompt templates are not loaded.

See [skills, instructions, and durable extensions](docs/workspace-resources.md) for directory conventions and the new extension API.

See [workspace configuration](docs/workspace-data-layout.md) for model JSON, credentials, profiles, and reload behavior.

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Show model, context window, session, queue, tools, and cost |
| `/compact` | Compact conversation context |
| `/models` | Choose a model with inline buttons |
| `/profile [name]` | List model profiles or select one |
| `/thinking` | Set thinking level for the current model |
| `/workspaces` | Switch between configured project directories |
| `/new` | Start a fresh session |
| `/stop` | Abort the running task and clear queued messages |
| `/resume` | Resume one of the 5 most recent sessions |
| `/recent` | Show the last few messages of the current session |
| `/skills` | List skills; explicitly invoke one with `/skill:name task` |
| `/reload` | Validate and reload workspace model configuration, preserving the current session |
| `/help` | List available commands |
| `/start` | Welcome message and quick start hint |
| `/exit` | Exit the pi-pilot process |

This order is the source of truth for the Telegram command menu and `/help` output; it comes from `CHAT_COMMANDS` in `src/runtime/chat-commands.ts`.

## Run from Source

Create `<workspace>/pi-pilot/config/.env` using `.env.example`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
DEEPSEEK_API_KEY=your-provider-key
```

Copy `examples/config/settings.json` and `models.json` into that config directory. The example selects DeepSeek Flash with thinking off; edit settings for another provider/model. Install and start from this repository:

```bash
bun install
bun run start --workspaces /path/to/project
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

CLI values take precedence over process environment, then workspace `.env`; `settings.json` supplies the default log level. Workspace discovery uses `--workspaces`, process `PI_PILOT_WORKSPACES`, or startup cwd. Set these before loading workspace configuration. `PI_PILOT_MODEL` and `PI_PILOT_DATA_DIR` are removed; configure model defaults in `settings.json`.

## Docker

Build this experimental branch locally; the published `latest` image tracks main.
Create the configuration under the mounted workspace, then run:

```bash
mkdir -p pi-pilot/config
cp .env.example pi-pilot/config/.env
cp examples/config/settings.json examples/config/models.json pi-pilot/config/
# Fill credentials in pi-pilot/config/.env before starting.
docker compose up --build
```

The included compose file mounts the project at `/workspace`; configuration,
state and attachments remain in `/workspace/pi-pilot` on that bind mount.
The mounted directory must be writable by the container's `bun` user.
A container restart resumes unfinished work.

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

Each workspace has its own model collection, credentials and sessions. Telegram process settings come from the first workspace at startup and stay fixed when switching workspaces. Workspace environment files are read without mutating the process environment. Accepted files remain under their receiving workspace; a delayed file message is rejected if the selected workspace changed before admission.

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
