# pi-pilot

> Pi in your pocket. Code from anywhere.

A Telegram bot for running [pi](https://github.com/earendil-works/pi-mono) from chat: send coding requests, stream replies, switch models, and resume sessions.

## Features

- Streaming Telegram replies
- Inline model picker
- Workspace and session switching
- Message queue per chat
- Status, stop, and compact commands
- File attachments (photos, documents, videos, voice)
- Docker image published to Docker Hub

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

You can also send a coding request directly. If a task is already running, new messages are queued.

## Local Run

Run with CLI options:

```bash
pi-pilot \
  --telegram-token 123456:your-token \
  --allowed-users 123456789 \
  --cwd /path/to/project \
  --workspaces /path/to/project,/path/to/other-project \
  --log-level info
```

Or create `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_ALLOWED_USERS=123456789
PI_PILOT_CWD=/path/to/project
PI_PILOT_WORKSPACES=/path/to/project,/path/to/other-project
PI_PILOT_LOG_LEVEL=info
```

Install and start from this repository:

```bash
bun install
bun run start
```

`PI_PILOT_CWD` is the project directory pi will work in. If unset, it defaults to the current process directory. CLI options take precedence over environment variables.

## Global CLI

Install the package globally, then launch it from any project directory:

```bash
bun add -g pi-pilot
pi-pilot --telegram-token 123456:your-token --cwd "$PWD" --allowed-users 123456789
```

For local development, link this repository as a global command:

```bash
bun link
pi-pilot --help
```

Available CLI options:

| Option | Environment Variable | Description |
|--------|----------------------|-------------|
| `--telegram-token`, `--bot-token` | `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `--cwd` | `PI_PILOT_CWD` | Default project directory |
| `--workspaces` | `PI_PILOT_WORKSPACES` | Comma-separated workspace paths |
| `--allowed-users` | `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs |
| `--log-level` | `PI_PILOT_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |

## Docker

Use the published image:

```yaml
services:
  pi-pilot:
    image: dandkong/pi-pilot:latest
    container_name: pi-pilot
    restart: unless-stopped
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_ALLOWED_USERS: ${TELEGRAM_ALLOWED_USERS}
      PI_PILOT_CWD: /workspace/project-a
      PI_PILOT_WORKSPACES: /workspace/project-a,/workspace/project-b
      PI_PILOT_LOG_LEVEL: info
      TZ: Asia/Shanghai
    volumes:
      - /path/to/projects:/workspace
      - /path/to/pi-agent:/home/bun/.pi/agent
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

## Storage

- `/workspace` - the project directory pi can read and edit.
- `/home/bun/.pi/agent` - pi auth, config, and persisted sessions.
- Runtime queues are in memory and are cleared when the bot restarts.

Mount both paths explicitly in Docker. Only mounted directories are available to the container.

## Workspaces

`PI_PILOT_CWD` is the default workspace. Add `PI_PILOT_WORKSPACES` to switch between mounted directories with `/workspaces`:

```env
PI_PILOT_CWD=/workspace/project-a
PI_PILOT_WORKSPACES=/workspace/project-a,/workspace/project-b
```

If `PI_PILOT_WORKSPACES` is empty, only `PI_PILOT_CWD` is available. If it does not include `PI_PILOT_CWD`, the default is added first automatically.

## Access Control

Set `TELEGRAM_ALLOWED_USERS` to a comma-separated list of Telegram user IDs:

```env
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

Leave it empty to allow all users. User IDs are logged when unauthorized users are rejected.

## Build Locally

```bash
docker build -t pi-pilot .
```

Or use the included local compose file:

```bash
cp .env.example .env
docker compose up --build
```

## License

MIT
