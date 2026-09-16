#!/usr/bin/env bash
# LBV2-3 — attack tests for vault isolation in the local prototype stack.
# Run from deploy/stack/ with the stack up: tests/isolation.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
STACK=${STACK_NAME:-lokyy-stack}
tests/wait-ready.sh "${WAIT_TIMEOUT:-300}" || exit 1

pass=0 fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
expect() { # expect <name> <actual> <allowed-regex>
  if [[ "$2" =~ ^($3)$ ]]; then ok "$1 → $2"; else bad "$1 → $2 (expected $3)"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# access <jar> <url> [curl args] → DATA (vault answered), DENIED (Authentik "Permission denied"), LOGIN, or OTHER:<code>
access() {
  local jar=$1 url=$2; shift 2
  local body; body=$(mktemp)
  local out; out=$(curl -s -L -b "$jar" -c "$jar" -o "$body" -w '%{http_code} %{url_effective}' "$@" "$url")
  local status=${out%% *} final=${out#* }
  if [[ $status == 200 && ${final%%\?*} == "${url%%\?*}" ]] && jq -e . "$body" >/dev/null 2>&1; then echo DATA
  elif grep -q "Permission denied" "$body"; then echo DENIED
  elif [[ $final == *"/if/flow/default-authentication-flow/"* ]]; then echo LOGIN
  else echo "OTHER:$status"; fi
  rm -f "$body"
}
V=http://%s.vault.localhost:18080

jar_anna=$(mktemp) jar_ben=$(mktemp)
trap 'rm -f "$jar_anna" "$jar_ben"' EXIT

echo "== 1. Unauthenticated access is redirected to the login"
for v in anna ben firma; do
  expect "anon → $v /api/config" "$(code "$(printf $V $v)/api/config")" "302"
done
expect "anon → metamcp admin" "$(code http://mcp.localhost:18080/)" "302"

echo "== 2. Browser session isolation (Authentik policies)"
tests/login.sh "$jar_anna" "$(printf $V anna)/" anna "$DEMO_PASS_ANNA" || bad "anna login"
tests/login.sh "$jar_ben"  "$(printf $V ben)/"  ben  "$DEMO_PASS_BEN"  || bad "ben login"
expect "anna → anna"  "$(access "$jar_anna" "$(printf $V anna)/api/config")"  "DATA"
expect "ben  → ben"   "$(access "$jar_ben"  "$(printf $V ben)/api/config")"   "DATA"
expect "anna → ben"   "$(access "$jar_anna" "$(printf $V ben)/api/config")"   "DENIED"
expect "ben  → anna"  "$(access "$jar_ben"  "$(printf $V anna)/api/config")"  "DENIED"
expect "anna (reader) → firma web" "$(access "$jar_anna" "$(printf $V firma)/api/config")" "DENIED"
expect "ben (writer) → firma web"  "$(access "$jar_ben"  "$(printf $V firma)/api/config")" "DATA"
expect "anna → metamcp admin" "$(access "$jar_anna" http://mcp.localhost:18080/api/health)" "DENIED"

echo "== 3. Header forgery through Traefik"
# Vaults trust X-authentik-username in guarded mode (LBV2-9); section 3b checks what they receive.
expect "anna → ben with forged X-authentik-username: ben" \
  "$(access "$jar_anna" "$(printf $V ben)/api/config" -H 'X-authentik-username: ben')" "DENIED"
expect "anna → own vault with wrong X-Vault-Proxy-Secret (Traefik must overwrite)" \
  "$(code -b "$jar_anna" -H 'X-Vault-Proxy-Secret: wrong-wrong-wrong-wrong-wrong-wrong' "$(printf $V anna)/api/config")" "200"
expect "anon → ben with ben's real proxy secret (secret alone is not a login)" \
  "$(code -H "X-Vault-Proxy-Secret: $PROXY_SECRET_BEN" "$(printf $V ben)/api/config")" "302"

echo "== 3b. Identity headers as the vault receives them (test-only echo behind anna's router chain)"
# The vault trusts x-authentik-username (identity) and x-authentik-groups (VAULT_ADMIN_GROUPS) when
# VAULT_PROXY_SECRET is set (LBV2-9). Traefik must replace client values with Authentik's.
docker compose -f compose.yml -f tests/echo.override.yml up -d --no-deps echo >/dev/null 2>&1
echo_get() { # echo_get [curl header args] → lower-cased request headers seen by the backend
  local out
  for _ in $(seq 1 20); do
    out=$(curl -s -b "$jar_anna" "$@" "$(printf $V anna)/__echo")
    [[ $out == *"GET /__echo"* ]] && { tr 'A-Z' 'a-z' <<<"$out" | tr -d '\r'; return; }
    sleep 1
  done
  echo "NO-ECHO"
}
hdr() { grep -E "^$1:" | sed -E "s/^$1: ?//" | tr '\n' ';' | sed 's/;$//'; }
base=$(echo_get)
expect "echo baseline: username from Authentik" "$(hdr x-authentik-username <<<"$base")" "anna"
anna_groups=$(hdr x-authentik-groups <<<"$base")
expect "echo baseline: anna's groups (no lokyy-admins, no firma admin)" \
  "$([[ -n $anna_groups && $anna_groups != *lokyy-admins* && $anna_groups != *vault-firma-admin* ]] && echo ok || echo "$anna_groups")" "ok"
for variant in 'X-authentik-username: ben' 'x-authentik-username: ben' 'X-AUTHENTIK-USERNAME: ben'; do
  expect "client '$variant' is replaced" "$(echo_get -H "$variant" | hdr x-authentik-username)" "anna"
done
expect "two client X-authentik-username headers are replaced by one" \
  "$(echo_get -H 'X-authentik-username: ben' -H 'X-authentik-username: akadmin' | hdr x-authentik-username)" "anna"
expect "underscore variant X_authentik_username does not change the identity header" \
  "$(echo_get -H 'X_authentik_username: ben' | hdr x-authentik-username)" "anna"
expect "client X-Mindbase-User is stripped" "$(echo_get -H 'X-Mindbase-User: ben' | grep -c '^x-mindbase-user:')" "0"
expect "client X-authentik-groups cannot grant admin" \
  "$(echo_get -H 'X-authentik-groups: lokyy-admins|vault-firma-admin' | hdr x-authentik-groups)" "$(sed 's/[|.]/\\&/g' <<<"$anna_groups")"
expect "client X-authentik-groups: lokyy-admins never reaches the vault" \
  "$(echo_get -H 'X-authentik-groups: lokyy-admins' | grep -c 'lokyy-admins')" "0"
expect "unauthenticated request with forged identity headers never reaches the vault" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-authentik-username: anna' -H 'X-authentik-groups: lokyy-admins' "$(printf $V anna)/__echo")" "302"
docker compose -f compose.yml -f tests/echo.override.yml rm -sf echo >/dev/null 2>&1

echo "== 4. Direct container access bypassing Traefik"
in_c() { docker compose exec -T "$1" sh -c "$2" 2>/dev/null; }
expect "metamcp → vault-anna:4321 (no proxy secret)" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://mcp.vault-anna:4321/api/config")" "403"
expect "metamcp → vault-anna:4322 without token" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://mcp.vault-anna:4322/mcp")" "401"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
expect "metamcp → vault-anna:4322 with anna's token (intended path)" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer $MCP_TOKEN_ANNA' -d '$init' http://mcp.vault-anna:4322/mcp")" "200"
expect "metamcp → vault-ben:4322 with anna's token" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'authorization: Bearer $MCP_TOKEN_ANNA' http://mcp.vault-ben:4322/mcp")" "401"

echo "== 4b. Company vault read-only profile (fail-closed, enforced in the vault)"
mcp_post() { # mcp_post <token> <json> [session] -> writes headers+body to stdout
  in_c metamcp "curl -s -i --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer $1' ${3:+-H 'mcp-session-id: $3'} -d '$2' http://mcp.vault-firma:4322/mcp"
}
ro_init=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" "$init")
ro_sid=$(grep -i '^mcp-session-id:' <<<"$ro_init" | awk '{print $2}' | tr -d '\r')
expect "firma read-only token opens a session" "$([[ -n "$ro_sid" ]] && echo yes || echo no)" "yes"
mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$ro_sid" >/dev/null
ro_tools=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$ro_sid" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l)
expect "firma read-only tools/list has exactly 12 tools" "$ro_tools" "12"
ro_write=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"reader-attack"}}}' "$ro_sid" | grep -o 'Tool not available' | head -1)
expect "firma read-only create_note rejected" "$ro_write" "Tool not available"
expect "firma read-only session refuses full token (403)" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer $MCP_TOKEN_FIRMA' -H 'mcp-session-id: $ro_sid' -d '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\"}' http://mcp.vault-firma:4322/mcp")" "403"
full_tools=$(in_c metamcp "curl -s --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer $MCP_TOKEN_FIRMA' -D /tmp/h -d '$init' http://mcp.vault-firma:4322/mcp >/dev/null; sid=\$(grep -i '^mcp-session-id:' /tmp/h | awk '{print \$2}' | tr -d '\r'); curl -s --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer $MCP_TOKEN_FIRMA' -H \"mcp-session-id: \$sid\" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' http://mcp.vault-firma:4322/mcp" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l)
expect "firma full token tools/list has all 50 tools" "$full_tools" "50"

echo "== 5. Lateral movement from a vault container (e.g. via SSRF)"
for target in mcp.vault-ben:4322 vault-ben:4321 vault-ben:4322 vault-firma:4321 vault-firma:4322 authentik-server:9000 authentik-db:5432 metamcp-db:5432; do
  expect "vault-anna → $target" \
    "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://$target/ || true")" "000"
done
# Accepted residual path: MetaMCP must reach vaults over mcp-<vault>, so a vault can reach MetaMCP back.
# Its surface must stay authenticated and closed for self-registration.
expect "vault-anna → metamcp tRPC without login" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://metamcp:12008/trpc/frontend.mcpServers.list")" "401"
users_before=$(docker compose exec -T metamcp-db psql -U metamcp -d metamcp -tAc "select count(*) from users")
in_c vault-anna "curl -s --max-time 5 -X POST -H 'content-type: application/json' -d '{\"email\":\"probe@evil.test\",\"password\":\"Passw0rd!Passw0rd\",\"name\":\"p\"}' http://metamcp:12008/api/auth/sign-up/email" >/dev/null
users_after=$(docker compose exec -T metamcp-db psql -U metamcp -d metamcp -tAc "select count(*) from users")
docker compose exec -T metamcp-db psql -U metamcp -d metamcp -qc "delete from sessions where user_id in (select id from users where email='probe@evil.test'); delete from accounts where user_id in (select id from users where email='probe@evil.test'); delete from users where email='probe@evil.test'" >/dev/null
expect "vault-anna → metamcp self-registration creates no account (users $users_before → $users_after)" \
  "$([[ "$users_before" == "$users_after" ]] && echo unchanged || echo CREATED)" "unchanged"
expect "vault-anna → traefik → ben (no session)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: ben.vault.localhost:18080' http://traefik/api/config")" "302"
expect "vault-anna → internet (EUrouter must stay reachable)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://www.eurouter.ai/")" "200|301|302|307|308"

echo "== 5b. Network topology (name-independent)"
members() { docker network inspect "${STACK}_$1" --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | sed -E "s/^${STACK}-//; s/-[0-9]+\$//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//'; }
for v in anna ben firma; do
  expect "web-$v members" "$(members web-$v)" "traefik vault-$v"
  expect "mcp-$v members" "$(members mcp-$v)" "metamcp vault-$v"
  expect "vault-$v networks" "$(docker inspect "${STACK}-vault-$v-1" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed "s/^${STACK}_//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')" "egress mcp-$v web-$v"
done
expect "egress inter-container traffic disabled" \
  "$(docker network inspect "${STACK}_egress" --format '{{index .Options "com.docker.network.bridge.enable_icc"}}')" "false"
# Probe every other vault by IP on every network, so a shared network is caught even if DNS points elsewhere.
for target in ben firma; do
  for ip in $(docker inspect "${STACK}-vault-$target-1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'); do
    for port in 4321 4322; do
      expect "vault-anna → vault-$target $ip:$port" \
        "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://$ip:$port/ || true")" "000"
    done
  done
done

echo "== 6. Nothing but Traefik is published on the host"
published=$(docker compose ps --format json | jq -r 'select(.Service != "traefik") | .Service as $s | (.Publishers // [])[] | select(.PublishedPort != 0) | "\($s):\(.PublishedPort)"' || true)
[[ -z "$published" ]] && ok "only traefik publishes ports" || bad "published ports: $published"
expect "host → 127.0.0.1:18080 bound to loopback only" \
  "$(docker compose port traefik 80 | cut -d: -f1)" "127\.0\.0\.1"

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
