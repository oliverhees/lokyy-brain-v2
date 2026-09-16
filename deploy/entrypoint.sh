#!/usr/bin/env bash
# Starts the vault web server and, if MCP_HTTP_PORT is set, the MCP server over
# Streamable HTTP. If either process exits, the other is stopped gracefully and
# the container exits non-zero (so on-failure restart policies also apply). SIGTERM/SIGINT are
# forwarded to both children so in-flight markdown writes can finish.
set -uo pipefail

pids=()
stop_children() {
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
}
trap 'stop_children; exit 143' TERM INT

if [[ -n "${MCP_HTTP_PORT:-}" ]]; then
  # The MCP process never needs the web proxy secret (least privilege).
  env -u VAULT_PROXY_SECRET node /app/apps/mcp/dist/http.js &
  pids+=($!)
fi

(cd /app/apps/server && exec node dist/server.mjs) &
pids+=($!)

code=0
wait -n "${pids[@]}" || code=$?
# Both are long-running services: any exit, even a clean one, is a failure.
[[ "$code" -eq 0 ]] && code=1
stop_children
exit "$code"
