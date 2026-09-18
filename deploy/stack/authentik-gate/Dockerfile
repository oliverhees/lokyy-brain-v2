# authentik-gate (LBV2-28): narrow Authentik API for the setup portal. Node built-ins only, TypeScript
# run via Node's type stripping. Tests run in a separate stage so a failing test fails the build.
FROM node:24-alpine AS test
WORKDIR /gate
COPY src ./src
COPY test ./test
RUN node --test test/*.test.ts

FROM node:24-alpine
WORKDIR /gate
COPY --from=test /gate/src ./src
USER node
ENV NODE_ENV=production
EXPOSE 8080
# /healthz is not served: an unauthenticated request answers 401, which proves the process is up
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/v1/users').then(r=>process.exit(r.status===401?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
