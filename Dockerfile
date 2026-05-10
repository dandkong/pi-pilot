FROM oven/bun:latest

WORKDIR /app

ENV NODE_ENV=production \
    PI_PILOT_CWD=/workspace

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN mkdir -p /workspace && chown -R bun:bun /app /workspace

USER bun

VOLUME ["/workspace", "/home/bun/.pi/agent"]

CMD ["bun", "run", "start"]
