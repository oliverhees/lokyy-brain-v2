#!/usr/bin/env bash
# LBV2-28 — portal E2E stack (project lokyy-portal, 127.0.0.1:18380, 10.234.0.0/16).
#   test/e2e/run.sh up          generate .env (random secrets, once), build the portal image, start
#   test/e2e/run.sh test        run test/integration inside the stack network (tester service)
#   test/e2e/run.sh down        stop and delete the stack incl. volumes
set -euo pipefail
cd "$(dirname "$0")"
repo=$(git rev-parse --show-toplevel)
compose=(docker compose -p lokyy-portal -f compose.yml --env-file .env)

gen() { openssl rand -hex 32; }
if [[ ! -f .env ]]; then
  umask 077
  {
    for v in AUTHENTIK_PG_PASS AUTHENTIK_SECRET_KEY AUTHENTIK_ADMIN_PASS AUTHENTIK_API_TOKEN PORTAL_PROXY_SECRET \
             METAMCP_PG_PASS METAMCP_AUTH_SECRET METAMCP_ADMIN_PASS \
             MCP_TOKEN_V01 MCP_TOKEN_V02 MCP_TOKEN_FIRMA MCP_READONLY_TOKEN_FIRMA \
             PROXY_SECRET_V01 PROXY_SECRET_V02 PROXY_SECRET_FIRMA; do
      echo "$v=$(gen)"
    done
    echo "REPO_DIR=$repo"
    echo "PORTAL_DIR=$repo/apps/portal"
    echo "HOST_UID=$(id -u)"
    echo "HOST_GID=$(id -g)"
  } >.env
fi

wait_for() { # wait_for <description> <command...>
  local what=$1; shift
  local deadline=$((SECONDS + 300))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || { echo "$what not ready after 300s" >&2; exit 1; }
    sleep 5
  done
}

case ${1:-} in
  up)
    "${compose[@]}" build portal
    "${compose[@]}" up -d
    wait_for "authentik blueprints" "${compose[@]}" exec -T authentik-server ak shell -c \
      'from authentik.flows.models import Flow; import sys; sys.exit(0 if Flow.objects.filter(slug="lokyy-set-password").exists() else 1)'
    wait_for "portal" sh -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' \$(${compose[*]} ps -q portal))\" = healthy ]"
    # The embedded outpost picks up the blueprint providers with a delay; until then forward-auth answers 404.
    for h in app v01 v02 firma; do
      wait_for "forward-auth for $h" sh -c "[ \"\$(curl -s -o /dev/null -w %{http_code} -H 'Host: $h.portal.localhost:18380' http://127.0.0.1:18380/)\" = 302 ]"
    done
    echo "stack up: http://app.portal.localhost:18380 (akadmin, password AUTHENTIK_ADMIN_PASS in test/e2e/.env)"
    ;;
  test)
    "${compose[@]}" --profile test run --rm tester npx vitest run test/integration
    # Vault config entrypoint, seen from the portal: only GET/PUT /api/config and POST /api/config/test
    "${compose[@]}" exec -T portal node -e '
      const base = process.env.VAULT_ADMIN_URL;
      const cases = [["GET", "/v01/api/config", 200], ["POST", "/v01/api/config", 404], ["DELETE", "/v01/api/config", 404],
        ["GET", "/v01/api/wiki", 404], ["GET", "/v01/api/config/../server", 404], ["POST", "/firma/api/config/test", 400], ["GET", "/v09/api/config", 404]];
      let bad = 0;
      (async () => {
        for (const [m, p, want] of cases) {
          const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
          const ok = want === 400 ? r.status >= 400 && r.status < 500 && r.status !== 404 : r.status === want;
          console.log((ok ? "ok  " : "FAIL") + " " + m + " " + p + " -> " + r.status);
          if (!ok) bad++;
        }
        process.exit(bad ? 1 : 0);
      })();'
    ;;
  down)
    "${compose[@]}" --profile test down -v --remove-orphans
    ;;
  *) echo "usage: $0 up|test|down" >&2; exit 2 ;;
esac
