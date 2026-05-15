FROM ghcr.io/astral-sh/uv:latest AS uv

FROM oven/bun:latest

COPY --from=uv /uv /usr/local/bin/uv
COPY --from=uv /uvx /usr/local/bin/uvx

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN mkdir -p /workspace && chown -R bun:bun /app /workspace

USER bun

CMD ["bun", "/app/index.ts"]
