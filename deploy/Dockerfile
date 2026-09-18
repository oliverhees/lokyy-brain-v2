# Lokyy Brain v2 — self-hosted vault image, built from source (no prebuilt npm bundle).
# Runs the web server (port 4321). When MCP_HTTP_PORT is set, the MCP server is
# also served over Streamable HTTP (requires MCP_HTTP_TOKEN, see apps/mcp/src/http.ts).
#
# Stages: build (full workspace, dev deps) -> prod-deps (production-only
# node_modules for server and MCP) -> runtime (only built artifacts).
# All stages use Debian bookworm so native modules (better-sqlite3, argon2,
# sharp, onnxruntime-node) match the runtime glibc.

FROM node:20-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -F @mindbase/core build \
 && pnpm -F @mindbase/web build \
 && pnpm -F mindbase-mcp build \
 && node deploy/build-server.mjs

FROM node:20-bookworm AS prod-deps
WORKDIR /src
RUN corepack enable
# Workspace manifests only: the dependency layer does not change with source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY packages/core/package.json packages/core/
RUN CI=true pnpm install --prod --frozen-lockfile \
      --filter @mindbase/server... --filter mindbase-mcp... \
 # tsx is a runtime dependency of the dev server script only; the image runs compiled JS.
 && rm -rf node_modules/.pnpm/tsx@* node_modules/.pnpm/esbuild@* node_modules/.pnpm/@esbuild+* \
           apps/server/node_modules/tsx \
 # Files never loaded at runtime: other-libc/other-OS native binaries, type
 # declarations, source maps.
 && rm -rf node_modules/.pnpm/*linuxmusl* node_modules/.pnpm/*-musl@* \
           node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v3/darwin \
           node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v3/win32 \
 && find node_modules/.pnpm -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 # Symlinks left dangling by the removals above and by workspace links whose
 # targets are not shipped (@mindbase/core is bundled into server.mjs).
 && rm -f node_modules/.pnpm/node_modules/@mindbase/core apps/server/node_modules/@mindbase/core \
 && find node_modules apps/server/node_modules apps/mcp/node_modules -xtype l -delete

# Shared embedding service (LBV2-26, deploy/stack/embed): one BGE-M3 for all vaults of a server.
# Build with --target embed. Its own tests run first (a failing test fails the build); runtime reuses
# the vault's production node_modules for @xenova/transformers + onnxruntime-node (same lockfile).
# Node 24 runs the TypeScript sources directly (type stripping); onnxruntime-node is N-API.
FROM node:24-alpine AS embed-test
WORKDIR /embed
COPY deploy/stack/embed/package.json ./
COPY deploy/stack/embed/src ./src
COPY deploy/stack/embed/test ./test
RUN node --test test/*.test.ts

FROM node:24-bookworm-slim AS embed
WORKDIR /app
COPY --from=prod-deps /src/node_modules /app/node_modules
COPY --from=prod-deps /src/apps/server/node_modules /app/apps/server/node_modules
COPY --from=embed-test /embed/package.json /app/embed/package.json
COPY --from=embed-test /embed/src /app/embed/src
RUN useradd -r -u 10002 embed
USER embed
ENV NODE_ENV=production \
    EMBED_MODELS_DIR=/models \
    EMBED_TRANSFORMERS_FROM=/app/apps/server/
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EMBED_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/embed/src/main.ts"]

FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /src/node_modules /app/node_modules
COPY --from=prod-deps /src/apps/server/node_modules /app/apps/server/node_modules
COPY --from=prod-deps /src/apps/mcp/node_modules /app/apps/mcp/node_modules
COPY --from=build /src/apps/server/package.json /app/apps/server/package.json
COPY --from=build /src/apps/server/dist /app/apps/server/dist
COPY --from=build /src/apps/mcp/package.json /app/apps/mcp/package.json
COPY --from=build /src/apps/mcp/dist /app/apps/mcp/dist
COPY --from=build /src/apps/web/dist /app/apps/web/dist
COPY --from=build /src/apps/plugin/templates /app/apps/plugin/templates
COPY --from=build /src/schema /app/schema
COPY --from=build /src/deploy/entrypoint.sh /app/deploy/entrypoint.sh
# Model cache: @xenova/transformers caches downloaded models (BGE-M3) in
# <package>/.cache. That path is redirected to /models, writable by the vault
# user. Mount a named volume at /models to keep models across container
# recreation (and share them between vault containers).
ENV NODE_ENV=production \
    PORT=4321 \
    MINDBASE_DATA_DIR=/data \
    MINDBASE_MDNS=off \
    MINDBASE_PLUGIN_ROOT=/app/apps/plugin \
    VAULT_REQUIRE_PROXY_SECRET=1
RUN useradd -r -u 10001 -m vault \
 && mkdir -p /data /models && chown vault /data /models \
 && for d in /app/node_modules/.pnpm/@xenova+transformers@*/node_modules/@xenova/transformers; do \
      rm -rf "$d/.cache" && ln -s /models "$d/.cache"; \
    done \
 && test -L /app/node_modules/.pnpm/@xenova+transformers@*/node_modules/@xenova/transformers/.cache
USER vault
VOLUME ["/data"]
EXPOSE 4321 4322
# Secret is piped via stdin so it never appears in the process list. Web must answer 200; if MCP is enabled it must answer 401 without a token (alive, auth on).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD printf 'X-Vault-Proxy-Secret: %s\n' "$VAULT_PROXY_SECRET" | curl -fsS -o /dev/null -H @- http://127.0.0.1:4321/ \
   && { [ -z "$MCP_HTTP_PORT" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${MCP_HTTP_PORT}/mcp)" = "401" ]; } \
   || exit 1
ENTRYPOINT ["tini", "-g", "--"]
CMD ["/app/deploy/entrypoint.sh"]
