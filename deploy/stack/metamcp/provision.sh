#!/usr/bin/env bash
# LBV2-4 — idempotent MetaMCP provisioning from users.json (or USERS_FILE).
# For every user: own MetaMCP account (no login method kept), two MCP servers (own vault with its
# full token; company vault with the full token for writers, the read-only token for readers),
# one namespace, one API-key endpoint, one API key. Users no longer listed are removed.
#
# Usage (from deploy/stack, stack running):
#   metamcp/provision.sh                 create / reconcile everything
#   metamcp/provision.sh --rotate anna   additionally replace anna's API key
#   metamcp/provision.sh --rotate-all    replace every user's API key (see rotate-secrets.sh)
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
    --rotate-all) rotate+=("*"); shift ;;
    *) echo "usage: $0 [--rotate <username>]... [--rotate-all]" >&2; exit 2 ;;
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
chmod 700 secrets
# One run at a time: parallel runs could rotate or delete keys under each other.
exec 9>secrets/.provision.lock
flock -n 9 || { echo "another provisioning run is in progress" >&2; exit 1; }

out=secrets/metamcp-clients.json
rm -f "$out.tmp"
code=0
docker compose exec -T -w /app/apps/backend "${env_args[@]}" metamcp \
  node --input-type=module - <metamcp/provision.mjs >"$out.tmp" || code=$?
if jq -e '.users' "$out.tmp" >/dev/null 2>&1; then
  if [[ $code -ne 0 && -f $out ]]; then
    # Failed run: keep entries of users this run did not reach, flagged as possibly stale.
    jq -s '.[0] as $new | $new + {users: ($new.users + [.[1].users[] | select(.username as $u | ($new.users | map(.username) | index($u)) | not) | . + {stale: true}])}' \
      "$out.tmp" "$out" >"$out.merged" && mv "$out.merged" "$out.tmp"
  fi
  mv "$out.tmp" "$out"
  chmod 600 "$out"
  echo "wrote $out ($(jq '.users | length' "$out") users, status $(jq -r '.status' "$out"))" >&2
  if [[ $(jq -r '.restartMetamcp' "$out") == true ]]; then
    # MetaMCP keeps open sessions (and their upstream credentials) in memory; a changed or removed
    # user must not keep using them. A restart ends every session; clients reconnect with their key.
    echo "access of at least one user changed or was removed: restarting MetaMCP to end all open sessions" >&2
    docker compose restart metamcp >/dev/null
    deadline=$((SECONDS + 180))
    until [[ $(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q metamcp)") == healthy ]]; do
      ((SECONDS < deadline)) || { echo "MetaMCP not healthy after restart" >&2; exit 1; }
      sleep 2
    done
    echo "MetaMCP restarted" >&2
  fi
else
  rm -f "$out.tmp"
  [[ $code -ne 0 ]] || code=1
  echo "provisioning produced no client list; $out left unchanged" >&2
fi
exit "$code"
