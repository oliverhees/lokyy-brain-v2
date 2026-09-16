#!/usr/bin/env bash
# LBV2-4 — idempotent MetaMCP provisioning from users.json (or USERS_FILE).
# For every user: own MetaMCP account (no login method kept), two MCP servers (own vault with its
# full token; company vault with the full token for writers, the read-only token for readers),
# one namespace, one API-key endpoint, one API key. Users no longer listed are removed.
#
# Usage (from deploy/stack, stack running):
#   metamcp/provision.sh                 create / reconcile everything
#   metamcp/provision.sh --rotate anna   additionally replace anna's API key
# Output: secrets/metamcp-clients.json (mode 600, gitignored) with endpoint URL + API key per user.
# Runs inside the metamcp container (node + pg + better-auth are already there): no host deps
# besides docker and jq; vault tokens are passed by name (-e VAR), never on a command line.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

users_file=${USERS_FILE:-users.json}
rotate=()
while (($#)); do
  case $1 in
    --rotate) rotate+=("$2"); shift 2 ;;
    *) echo "usage: $0 [--rotate <username>]..." >&2; exit 2 ;;
  esac
done

LOKYY_USERS=$(jq -c . "$users_file")
LOKYY_ROTATE=$(printf '%s\n' "${rotate[@]:-}" | jq -Rsc 'split("\n") | map(select(length > 0))')
LOKYY_PUBLIC_BASE=${METAMCP_PUBLIC_BASE:-http://mcp.localhost:18080}
export LOKYY_USERS LOKYY_ROTATE LOKYY_PUBLIC_BASE

env_args=(-e LOKYY_USERS -e LOKYY_ROTATE -e LOKYY_PUBLIC_BASE)
for name in $(compgen -v | grep -E '^MCP_(READONLY_)?TOKEN_[A-Z0-9_]+$'); do env_args+=(-e "$name"); done

umask 077
mkdir -p secrets
out=secrets/metamcp-clients.json
docker compose exec -T -w /app/apps/backend "${env_args[@]}" metamcp \
  node --input-type=module - <metamcp/provision.mjs >"$out.tmp"
mv "$out.tmp" "$out"
chmod 600 "$out"
echo "wrote $out ($(jq '.users | length' "$out") users)" >&2
