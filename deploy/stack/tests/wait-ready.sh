#!/usr/bin/env bash
# Waits until the stack can serve the attack tests: every service healthy,
# the Authentik blueprint applied and the vault routes answered by forward-auth.
# Usage: tests/wait-ready.sh [timeout-seconds]   (default 300)
set -uo pipefail
cd "$(dirname "$0")/.."
deadline=$(( $(date +%s) + ${1:-300} ))
P=$(sed -nE "s/^STACK_HTTP_PORT=([0-9]+)$/\1/p" .env 2>/dev/null | tail -1)
P=${P:-${STACK_HTTP_PORT:-18080}}

step() { # step <description> <command...>
  local what=$1; shift
  until "$@" >/dev/null 2>&1; do
    if (( $(date +%s) > deadline )); then echo "TIMEOUT waiting for: $what" >&2; exit 1; fi
    sleep 3
  done
  echo "ready: $what"
}

healthy() {
  docker compose ps --format json | jq -se '
    [.[] | select(.Service != "metamcp-init" and .Service != "model-prefetch" and .Service != "traefik")] as $s
    | ($s | length) >= 7 and all($s[]; .Health == "healthy")'
}
blueprint() {
  docker compose exec -T authentik-worker ak shell -c "
from authentik.blueprints.models import BlueprintInstance
import sys; sys.exit(0 if BlueprintInstance.objects.filter(name='lokyy-vaults', status='successful').exists() else 1)"
}
routes() {
  for v in anna ben firma; do
    [[ $(curl -s -o /dev/null -w '%{http_code}' "http://$v.vault.localhost:$P/") == 302 ]] || return 1
  done
}
signup_closed() {
  docker compose logs metamcp-init 2>/dev/null | grep -q 'signup disabled'
}

step "all services healthy" healthy
step "Authentik blueprint lokyy-vaults applied" blueprint
step "vault routes protected by forward-auth" routes
step "MetaMCP signup closed" signup_closed
