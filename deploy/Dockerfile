# Lokyy Brain v2 — self-hosted vault image, built from source (no prebuilt npm bundle).
# Runs the web server (port 4321). The MCP server is built too and exposed
# over Streamable HTTP by deploy/entrypoint.sh when MCP_HTTP_PORT is set.
FROM node:20-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -F @mindbase/core build \
 && pnpm -F @mindbase/web build \
 && pnpm -F mindbase-mcp build

FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src /app
ENV NODE_ENV=production \
    PORT=4321 \
    MINDBASE_DATA_DIR=/data \
    MINDBASE_MDNS=off
RUN useradd -r -u 10001 -m vault && mkdir -p /data && chown vault /data
USER vault
VOLUME ["/data"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4321/ >/dev/null || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "cd apps/server && exec node --import tsx src/index.ts"]
