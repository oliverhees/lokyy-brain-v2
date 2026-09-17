# mcp-gate / vault-connector (LBV2-4, finding M2). Node built-ins only, TypeScript run via
# Node's built-in type stripping. Tests run in a separate stage so a failing test fails the build.
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
EXPOSE 8080 4322
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "const m=process.env.MODE||'gate';const h=m==='gate'?'127.0.0.1':process.env.CONNECTOR_LISTEN_HOST;const p=m==='gate'?8080:4322;require('http').get({host:h,port:p,path:'/',headers:{host:'health'}},r=>process.exit(r.statusCode===404?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/main.ts"]
