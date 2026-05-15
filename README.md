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
| `/resume` | Resume one of the 5 most recent sessions |
| `/new` | Start a fresh session |
| `/stop` | Abort the running task and clear queued messages |
| `/compact` | Compact conversation context |

## Run from Source

Create `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
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
  --workspaces /path/to/project,/path/to/other-project \
  --log-level info
```

Available options:

| Option | Environment Variable | Description |
|--------|----------------------|-------------|
| `--telegram-token`, `--bot-token` | `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `--workspaces` | `PI_PILOT_WORKSPACES` | Comma-separated workspace paths |
| `--allowed-users` | `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs |
| `--log-level` | `PI_PILOT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |

## Docker

### Use the published image

```yaml
services:
  pi-pilot:
    image: dandkong/pi-pilot:latest
    container_name: pi-pilot
    restart: unless-stopped
    working_dir: /workspace/project-a
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_ALLOWED_USERS: ${TELEGRAM_ALLOWED_USERS}
      PI_PILOT_WORKSPACES: /workspace/project-a,/workspace/project-b
      PI_PILOT_LOG_LEVEL: info
      TZ: Asia/Shanghai
    volumes:
      - /path/to/projects:/workspace
      - /path/to/pi:/home/bun/.pi
```

Then run:

```bash
docker compose up -d
```

Keep secrets in `.env`, not directly in `docker-compose.yml`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
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

Set `TELEGRAM_ALLOWED_USERS` to a comma-separated list of Telegram user IDs:

```env
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

Leave it empty to allow all users. User IDs are logged when unauthorized users are rejected.

## License

MIT
