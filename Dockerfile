FROM ghcr.io/astral-sh/uv:latest AS uv

FROM oven/bun:latest

COPY --from=uv /uv /usr/local/bin/uv
COPY --from=uv /uvx /usr/local/bin/uvx

# pi-ai provider SDKs require a recent Node.js runtime.
# Install Node.js 24 from NodeSource instead of Debian's default nodejs package.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends \
    git \
    wget \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    && node --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN mkdir -p /home/bun/.pi/pilot/durable && chown -R bun:bun /app /home/bun/.pi

USER bun

CMD ["bun", "/app/index.ts"]
