# pi-pilot

> Pi in your pocket. Create from anywhere.

pi-pilot is a Telegram interface for [pi](https://pi.dev/), bringing coding, research, automation, and anything else you can imagine to Telegram.

## Features

- Stream replies and tool activity back to chat
- Switch workspaces, models, and recent sessions
- Use pi extensions, skills, prompts, and persisted sessions
- Docker deployment support

## Prerequisites

Install and configure [pi](https://pi.dev/) first. pi-pilot reuses its model settings, credentials, sessions, extensions, skills, and prompts.

For Docker, mount the agent data directory to `/home/bun/.pi/agent`.

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Show current model, context, session, queue, tools, skills, and cost |
| `/workspaces` | Switch between configured project directories |
| `/models` | Choose a model with inline buttons |
| `/thinking` | Set thinking level for the current model |
| `/resume` | Resume one of the 5 most recent sessions |
| `/new` | Start a fresh session |
| `/stop` | Abort the running task and clear queued messages |
| `/compact` | Compact conversation context |
| `/reload` | Reload the current pi session and resources |
| `/exit` | Exit the pi-pilot process |

## Run from Source

Create `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
TELEGRAM_DEFAULT_CHAT_ID=123456789
PI_PILOT_WORKSPACES=/path/to/project,/path/to/other-project
PI_PILOT_LOG_LEVEL=info
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
| `--default-chat-id` | `TELEGRAM_DEFAULT_CHAT_ID` | Default Telegram chat ID for proactive notifications |
| `--log-level` | `PI_PILOT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |

## Docker

### First-time Setup

After starting the container, run pi inside the container to configure credentials and select a model:

```bash
docker exec -it pi-pilot pi
```

### Use the published image

```yaml
services:
  pi-pilot:
    image: dandkong/pi-pilot:latest
    container_name: pi-pilot
    restart: unless-stopped
    working_dir: /workspace
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_ALLOWED_USERS: ${TELEGRAM_ALLOWED_USERS}
      TELEGRAM_DEFAULT_CHAT_ID: ${TELEGRAM_DEFAULT_CHAT_ID}
      PI_PILOT_WORKSPACES: /workspace,/workspace-a
      PI_PILOT_LOG_LEVEL: info
      TZ: Asia/Shanghai
    volumes:
      - /path/to/projects:/workspace
      - /path/to/pi:/home/bun/.pi
```

### Build locally

Build an image from this repository:

```bash
docker build -t pi-pilot .
```

Or use the included local compose file:

```bash
cp .env.example .env
docker compose up --build
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

## Proactive Notifications

Set `TELEGRAM_DEFAULT_CHAT_ID` when notifications are not tied to an active user turn, such as background compaction or native pi plugin outputs:

```env
TELEGRAM_DEFAULT_CHAT_ID=123456789
```

For groups or supergroups, use the group chat ID, which is often negative or starts with `-100`. If unset, pi-pilot falls back to the first `TELEGRAM_ALLOWED_USERS` entry for personal private-chat setups. If both are empty, proactive notifications are disabled.

## License

MIT
