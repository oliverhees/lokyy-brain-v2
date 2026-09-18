#!/usr/bin/env bash
# LBV2-28 — portal E2E stack (project lokyy-portal, 127.0.0.1:18380, 10.234.0.0/16).
#   test/e2e/run.sh up          generate .env (random secrets, once) and start the stack
#   test/e2e/run.sh test        run the integration tests (test/integration) inside the stack network
#   test/e2e/run.sh down        stop and delete the stack incl. volumes
set -euo pipefail
cd "$(dirname "$0")"
here=$(pwd)
repo=$(git rev-parse --show-toplevel)
compose=(docker compose -p lokyy-portal -f compose.yml --env-file .env)

gen() { openssl rand -hex 32; }
if [[ ! -f .env ]]; then
  umask 077
  {
    echo "AUTHENTIK_PG_PASS=$(gen)"
    echo "AUTHENTIK_SECRET_KEY=$(gen)"
    echo "AUTHENTIK_ADMIN_PASS=$(gen)"
    echo "AUTHENTIK_API_TOKEN=$(gen)"
    echo "REPO_DIR=$repo"
    echo "PORTAL_DIR=$repo/apps/portal"
    echo "HOST_UID=$(id -u)"
    echo "HOST_GID=$(id -g)"
  } >.env
fi

wait_authentik() {
  local deadline=$((SECONDS + 300))
  until "${compose[@]}" exec -T authentik-server ak shell -c 'from authentik.flows.models import Flow; import sys; sys.exit(0 if Flow.objects.filter(slug="lokyy-set-password").exists() else 1)' >/dev/null 2>&1; do
    ((SECONDS < deadline)) || { echo "authentik blueprints not applied after 300s" >&2; exit 1; }
    sleep 5
  done
}

case ${1:-} in
  up)
    "${compose[@]}" up -d
    wait_authentik
    echo "stack up: http://auth.portal.localhost:18380"
    ;;
  test)
    "${compose[@]}" --profile test run --rm tester npx vitest run test/integration
    ;;
  down)
    "${compose[@]}" --profile test down -v --remove-orphans
    ;;
  *) echo "usage: $0 up|test|down" >&2; exit 2 ;;
esac
