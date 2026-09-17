#!/usr/bin/env bash
# LBV2-16 — static checks of the rendered Coolify template (no containers started).
# Renders compose.yml with a throw-away env from gen-env.sh (random values) and asserts the security
# invariants that do not need a running stack.
# Usage: deploy/coolify/tests/config-check.sh
set -euo pipefail
dir=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$dir/gen-env.sh" beta.example.test anna ben carl ops@example.test /nonexistent >"$tmp/env"
printf 'COOLIFY_PROXY_IP=10.0.1.5\n' >>"$tmp/env"
docker compose --env-file "$tmp/env" -f "$dir/compose.yml" config -q
docker compose --env-file "$tmp/env" -f "$dir/compose.yml" config --format json >"$tmp/c.json"

fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
q() { jq -r "$1" "$tmp/c.json"; }

check "no service publishes a port" '[[ $(q "[.services[] | (.ports // []) | length] | add") == 0 ]]'
check "only lokyy-traefik joins coolify" '[[ $(q "[.services | to_entries[] | select(.value.networks | has(\"coolify\")) | .key] | join(\",\")") == lokyy-traefik ]]'
check "forwarded headers trusted only from one /32" 'q ".services[\"lokyy-traefik\"].command[]" | grep -qx -- "--entrypoints.web.forwardedHeaders.trustedIPs=10.0.1.5/32"'

declare -A host=([u1]=anna.vault.beta.example.test [u2]=ben.vault.beta.example.test [u3]=carl.vault.beta.example.test [firma]=firma.vault.beta.example.test)
for v in u1 u2 u3 firma; do
  labels=$(q ".services[\"vault-$v\"].labels | to_entries[] | \"\(.key)=\(.value)\"")
  check "vault-$v networks exactly web/mcp/egress" '[[ $(q ".services[\"vault-$v\"].networks | keys | join(\",\")") == "egress,mcp-$v,web-$v" ]]'
  check "vault-$v chain starts with host pinning" 'grep -qx "traefik.http.routers.vault-$v.middlewares=vault-$v-fwd@docker,authentik@docker,vault-identity@docker,vault-$v-secret@docker" <<<"$labels"'
  check "vault-$v pins X-Forwarded-Host" 'grep -qx "traefik.http.middlewares.vault-$v-fwd.headers.customrequestheaders.X-Forwarded-Host=${host[$v]}" <<<"$labels"'
  check "vault-$v pins X-Forwarded-Proto" 'grep -qx "traefik.http.middlewares.vault-$v-fwd.headers.customrequestheaders.X-Forwarded-Proto=https" <<<"$labels"'
  check "vault-$v outpost router pins forwarded headers" 'grep -qx "traefik.http.routers.vault-$v-outpost.middlewares=vault-$v-fwd@docker" <<<"$labels"'
done
mlabels=$(q '.services.metamcp.labels | to_entries[] | "\(.key)=\(.value)"')
check "metamcp admin chain starts with host pinning" 'grep -qx "traefik.http.routers.metamcp.middlewares=metamcp-fwd@docker,authentik@docker" <<<"$mlabels"'
check "metamcp pins X-Forwarded-Host" 'grep -qx "traefik.http.middlewares.metamcp-fwd.headers.customrequestheaders.X-Forwarded-Host=mcp.beta.example.test" <<<"$mlabels"'
check "metamcp outpost router pins forwarded headers" 'grep -qx "traefik.http.routers.metamcp-outpost.middlewares=metamcp-fwd@docker" <<<"$mlabels"'
check "metamcp not on any vault network" '! q ".services.metamcp.networks | keys[]" | grep -qE "^(web|mcp)-(u[0-9]+|firma)$"'

check "gen-env rejects duplicate usernames" '! "$dir/gen-env.sh" x.test anna anna carl e@x.test >/dev/null 2>&1'
exit $fail
