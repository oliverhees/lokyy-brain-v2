# Lokyy setup portal (LBV2-28). Build context: repository root
#   docker build -f apps/portal/Dockerfile -t lokyy-portal .
# Stages: build (portal deps, client build, unit tests - a failing test fails the build) ->
# prod (production node_modules only) -> runtime (server sources run by Node's type stripping).
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @mindbase/portal \
 && pnpm -F @mindbase/portal typecheck \
 && pnpm -F @mindbase/portal test \
 && pnpm -F @mindbase/portal build

FROM node:24-alpine AS prod
WORKDIR /src
RUN corepack enable
COPY --from=build /src /src
RUN CI=true pnpm --filter @mindbase/portal deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 PORTAL_STATE_DIR=/state
WORKDIR /app/apps/portal
COPY --from=prod /out/package.json ./package.json
COPY --from=prod /out/node_modules ./node_modules
COPY --from=build /src/apps/portal/src/server ./src/server
COPY --from=build /src/apps/portal/src/shared ./src/shared
COPY --from=build /src/apps/portal/dist/client ./dist/client
# READ_ONLY_TOOL_NAMES single source (imported by src/server/metamcp.ts)
COPY --from=build /src/apps/mcp/src/access.ts /app/apps/mcp/src/access.ts
RUN rm -f src/server/*.test.ts \
 && mkdir -p /state && chown node:node /state
USER node
VOLUME /state
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server/main.ts"]
