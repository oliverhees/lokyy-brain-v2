#!/usr/bin/env bash
# LBV2-28 — portal E2E stack.
#   test/e2e/run.sh [-p project] [--port 18380] [--net TAG] [--vault-image IMAGE] up|test|down
# Defaults: project lokyy-portal, 127.0.0.1:18380, subnets 10.234.0-13.0/24. For a parallel stack (e.g.
# QA) choose another project, port and net block: -p lokyy-portal-qa --port 18382 --net 3 uses subnets
# 10.234.48-61.0/24 (block n = 16n…16n+13, n = 0…15). Secrets are generated once per project in
# test/e2e/.env.<project> (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
repo=$(git rev-parse --show-toplevel)

project=lokyy-portal port=18380 net=0
while (($#)); do
  case $1 in
    -p|--project) project=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --net) net=$2; shift 2 ;;
    --vault-image) export E2E_VAULT_IMAGE=$2; shift 2 ;;
    up|test|down) cmd=$1; shift ;;
    *) echo "usage: $0 [-p project] [--port port] [--net tag] [--vault-image image] up|test|down" >&2; exit 2 ;;
  esac
done
[[ -n ${cmd:-} ]] || { echo "usage: $0 [-p project] [--port port] [--net tag] [--vault-image image] up|test|down" >&2; exit 2; }
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ && $port =~ ^[0-9]+$ && $net =~ ^[0-9]+$ ]] && ((net <= 15)) || { echo "invalid project, port or net block (0-15)" >&2; exit 2; }

envfile=.env.$project
[[ $project == lokyy-portal && -f .env && ! -f $envfile ]] && cp .env "$envfile"
gen() { openssl rand -hex 32; }
if [[ ! -f $envfile ]]; then
  umask 077
  {
    for v in AUTHENTIK_PG_PASS AUTHENTIK_SECRET_KEY AUTHENTIK_ADMIN_PASS AUTHENTIK_API_TOKEN PORTAL_AUTHENTIK_TOKEN PORTAL_PROXY_SECRET \
             METAMCP_PG_PASS METAMCP_AUTH_SECRET METAMCP_ADMIN_PASS \
             MCP_TOKEN_V01 MCP_TOKEN_V02 MCP_TOKEN_FIRMA MCP_READONLY_TOKEN_FIRMA \
             PROXY_SECRET_V01 PROXY_SECRET_V02 PROXY_SECRET_FIRMA; do
      echo "$v=$(gen)"
    done
  } >"$envfile"
fi
grep -q '^PORTAL_AUTHENTIK_TOKEN=' "$envfile" || echo "PORTAL_AUTHENTIK_TOKEN=$(gen)" >>"$envfile"
grep -q '^PORTAL_GATE_SECRET=' "$envfile" || echo "PORTAL_GATE_SECRET=$(gen)" >>"$envfile"
# Optional real EUrouter key for the positive LLM path: EUROUTER_ENV=<file with EUROUTER_API_KEY=…>.
# Loaded here, handed to containers by variable name only, never printed.
if [[ -n ${EUROUTER_ENV:-} && -f $EUROUTER_ENV ]]; then
  E2E_EUROUTER_KEY=$(sed -n 's/^EUROUTER_API_KEY=//p' "$EUROUTER_ENV" | head -1)
  export E2E_EUROUTER_KEY
fi
export E2E_PROJECT=$project E2E_PUBLIC_PORT=$port
for i in $(seq 0 13); do export "E2E_NET_$i=10.234.$((net * 16 + i))"; done
export REPO_DIR=$repo PORTAL_DIR=$repo/apps/portal HOST_UID=$(id -u) HOST_GID=$(id -g)
compose=(docker compose -p "$project" -f compose.yml --env-file "$envfile")

wait_for() { # wait_for <description> <command...>
  local what=$1; shift
  local deadline=$((SECONDS + 600)) # first boot of Authentik can be slow on a busy host
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || { echo "$what not ready after 600s" >&2; exit 1; }
    sleep 5
  done
}

case $cmd in
  up)
    "${compose[@]}" build portal authentik-gate
    "${compose[@]}" up -d
    wait_for "authentik blueprints" "${compose[@]}" exec -T authentik-server ak shell -c \
      'from authentik.flows.models import Flow; from authentik.core.models import Token; import sys; sys.exit(0 if Flow.objects.filter(slug="lokyy-set-password").exists() and Token.objects.filter(identifier="lokyy-portal-api").exists() else 1)'
    wait_for "portal" sh -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' \$(${compose[*]} ps -q portal))\" = healthy ]"
    # Forward-auth must deliver a real identity to the portal, not just redirect (QA HIGH 1).
    "${compose[@]}" --profile test run --rm tester node test/e2e/ready.ts
    echo "stack $project up: http://app.portal.localhost:$port (akadmin, password AUTHENTIK_ADMIN_PASS in test/e2e/$envfile)"
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
    if [[ -n ${E2E_EUROUTER_KEY:-} ]]; then
      # Positive LLM path: every vault answers a real route-only chat through EUrouter (config/test of LBV2-30)
      "${compose[@]}" exec -T portal node -e '
        const base = process.env.VAULT_ADMIN_URL;
        (async () => {
          let bad = 0;
          for (const v of ["firma", "v01", "v02"]) {
            const cfg = await (await fetch(base + "/" + v + "/api/config")).json();
            const r = await fetch(base + "/" + v + "/api/config/test", { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ provider: cfg.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, ruleId: cfg.ruleId }) });
            const b = await r.json();
            // With a ruleId the vault sends rule_id and no model (a stored model value is ignored).
            const ok = b.ok === true && typeof cfg.ruleId === "string" && cfg.ruleId.length > 0;
            console.log((ok ? "ok  " : "FAIL") + " vault " + v + " answered via route " + cfg.ruleName + (ok ? "" : " -> " + (b.error ?? r.status)));
            if (!ok) bad++;
          }
          process.exit(bad ? 1 : 0);
        })();'
    fi
    ;;
  down)
    "${compose[@]}" --profile test down -v --remove-orphans
    ;;
esac
