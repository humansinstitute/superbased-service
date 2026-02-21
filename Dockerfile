FROM oven/bun:1.2 AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN chmod +x docker/entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3080

CMD ["sh", "docker/entrypoint.sh"]
