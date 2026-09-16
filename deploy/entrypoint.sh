#!/usr/bin/env bash
# Starts the vault web server and, if MCP_HTTP_PORT is set, the MCP server over
# Streamable HTTP. If either process exits, the container exits so the
# orchestrator restarts it.
set -euo pipefail

pids=()
if [[ -n "${MCP_HTTP_PORT:-}" ]]; then
  node /app/apps/mcp/dist/http.js &
  pids+=($!)
fi

(cd /app/apps/server && exec node --import tsx src/index.ts) &
pids+=($!)

trap 'kill -TERM "${pids[@]}" 2>/dev/null || true' TERM INT
wait -n "${pids[@]}"
code=$?
kill -TERM "${pids[@]}" 2>/dev/null || true
wait || true
exit "$code"
