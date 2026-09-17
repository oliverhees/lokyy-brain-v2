#!/usr/bin/env bash
# Runbook: rotate every access secret of the stack at once (e.g. after a MetaMCP DB leak —
# MetaMCP stores API keys and vault bearer tokens in plain text).
#
#   1. new MCP_TOKEN_*, MCP_READONLY_TOKEN_* and PROXY_SECRET_* in .env (old .env kept as .env.bak-<ts>, mode 600)
#   2. docker compose up -d        → vaults restart with the new tokens/proxy secrets,
#                                    Traefik picks up the new proxy-secret labels
#   3. tests/wait-ready.sh
#   4. metamcp/provision.sh --rotate-all → MetaMCP servers get the new bearer tokens,
#                                    every user gets a new API key (old keys stop working)
#   5. hand out secrets/metamcp-clients.json again
#
# MCP clients are down between step 2 and 4 (vaults reject the old tokens). Authentik, database
# passwords and MetaMCP's auth secret are not touched (rotate those separately if leaked).
# Usage (from deploy/stack, stack running): ./rotate-secrets.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || { echo ".env missing" >&2; exit 1; }

umask 077
backup=".env.bak-$(date +%Y%m%d%H%M%S)"
cp -p .env "$backup"
tmp=$(mktemp .env.XXXXXX)
rotated=0
while IFS= read -r line || [[ -n $line ]]; do
  if [[ $line =~ ^((MCP_TOKEN|MCP_READONLY_TOKEN|PROXY_SECRET)_[A-Z0-9_]+)= ]]; then
    printf '%s=%s\n' "${BASH_REMATCH[1]}" "$(openssl rand -hex 32)"
    rotated=$((rotated + 1))
  else
    printf '%s\n' "$line"
  fi
done <.env >"$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
echo "rotated $rotated secrets in .env (backup: $backup — delete it once the rotation is verified)"

docker compose up -d
tests/wait-ready.sh "${WAIT_TIMEOUT:-300}"
metamcp/provision.sh --rotate-all
echo "done: hand out secrets/metamcp-clients.json again"
