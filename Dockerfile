FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:24-bookworm

COPY --from=uv /uv /usr/local/bin/uv
COPY --from=uv /uvx /usr/local/bin/uvx

RUN corepack enable \
    && corepack prepare pnpm@10.31.0 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    python3 \
    python3-pip \
    python3-venv \
    && node --version \
    && pnpm --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
    && pnpm prune --prod \
    && ln -sf /app/node_modules/.bin/pi /usr/local/bin/pi \
    && chown -R node:node /app

ENV NODE_ENV=production
USER node

CMD ["node", "/app/dist/index.js"]
