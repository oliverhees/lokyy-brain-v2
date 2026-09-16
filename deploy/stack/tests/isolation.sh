#!/usr/bin/env bash
# LBV2-3 — attack tests for vault isolation in the local prototype stack.
# Run from deploy/stack/ with the stack up: tests/isolation.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

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
expect "anna → ben with forged X-authentik-username: ben" \
  "$(access "$jar_anna" "$(printf $V ben)/api/config" -H 'X-authentik-username: ben')" "DENIED"
expect "anna → own vault with wrong X-Vault-Proxy-Secret (Traefik must overwrite)" \
  "$(code -b "$jar_anna" -H 'X-Vault-Proxy-Secret: wrong-wrong-wrong-wrong-wrong-wrong' "$(printf $V anna)/api/config")" "200"
expect "anon → ben with ben's real proxy secret (secret alone is not a login)" \
  "$(code -H "X-Vault-Proxy-Secret: $PROXY_SECRET_BEN" "$(printf $V ben)/api/config")" "302"

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

echo "== 5. Lateral movement from a vault container (e.g. via SSRF)"
for target in mcp.vault-ben:4322 vault-ben:4321 vault-ben:4322 vault-firma:4321 vault-firma:4322 authentik-server:9000 authentik-db:5432 metamcp-db:5432; do
  expect "vault-anna → $target" \
    "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://$target/ || true")" "000"
done
# Accepted residual path: MetaMCP must reach vaults over mcp-<vault>, so a vault can reach MetaMCP back.
# Its surface must stay authenticated and closed for self-registration.
expect "vault-anna → metamcp tRPC without login" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://metamcp:12008/trpc/frontend.mcpServers.list")" "401"
expect "vault-anna → metamcp self-registration" \
  "$(in_c vault-anna "curl -s --max-time 5 -X POST -H 'content-type: application/json' -d '{\"email\":\"probe@evil.test\",\"password\":\"Passw0rd!Passw0rd\",\"name\":\"p\"}' http://metamcp:12008/api/auth/sign-up/email | grep -o FAILED_TO_CREATE_USER")" "FAILED_TO_CREATE_USER"
expect "vault-anna → traefik → ben (no session)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: ben.vault.localhost:18080' http://traefik/api/config")" "302"
expect "vault-anna → internet (EUrouter must stay reachable)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://www.eurouter.ai/")" "200|301|302|307|308"

echo "== 6. Nothing but Traefik is published on the host"
published=$(docker compose ps --format json | jq -r 'select(.Service != "traefik") | .Service as $s | (.Publishers // [])[] | select(.PublishedPort != 0) | "\($s):\(.PublishedPort)"' || true)
[[ -z "$published" ]] && ok "only traefik publishes ports" || bad "published ports: $published"
expect "host → 127.0.0.1:18080 bound to loopback only" \
  "$(docker compose port traefik 80 | cut -d: -f1)" "127\.0\.0\.1"

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
