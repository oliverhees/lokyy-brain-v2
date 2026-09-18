#!/usr/bin/env bash
# LBV2-3 — attack tests for vault isolation in the local prototype stack.
# Run from deploy/stack/ with the stack up: tests/isolation.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
STACK=${STACK_NAME:-lokyy-stack}
P=${STACK_HTTP_PORT:-18080}
TAG=${IMAGE_TAG:-dev}
tests/port-gate.sh || exit 1
tests/wait-ready.sh "${WAIT_TIMEOUT:-300}" || exit 1

pass=0 fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
# xfail: EXPECTED to fail until a known finding is fixed; reported as XFAIL (never hidden), XPASS once fixed.
xfailed=0 xpassed=0
xfail() {
  if [[ "$2" =~ ^($3)$ ]]; then echo "XPASS $1 → $2 (known issue $4 seems fixed: turn this into a normal check)"; xpassed=$((xpassed+1))
  else echo "XFAIL $1 → $2 (expected $3; KNOWN $4)"; xfailed=$((xfailed+1)); fi
}
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
V=http://%s.vault.localhost:$P

jar_anna=$(mktemp) jar_ben=$(mktemp)
hdir=$(mktemp -d)
hfile() { local f; f=$(mktemp "$hdir/h.XXXXXX"); printf '%s\n' "$1" >"$f"; echo "$f"; }  # secret headers via file, not argv
cleanup() {
  rm -rf "$jar_anna" "$jar_ben" "$hdir"
  docker compose -f compose.yml -f tests/echo.override.yml rm -sf echo >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 1. Unauthenticated access is redirected to the login"
for v in anna ben firma; do
  expect "anon → $v /api/config" "$(code "$(printf $V $v)/api/config")" "302"
done
expect "anon → metamcp admin" "$(code http://mcp.localhost:$P/)" "302"

echo "== 2. Browser session isolation (Authentik policies)"
tests/login.sh "$jar_anna" "$(printf $V anna)/" anna "$DEMO_PASS_ANNA" || bad "anna login"
tests/login.sh "$jar_ben"  "$(printf $V ben)/"  ben  "$DEMO_PASS_BEN"  || bad "ben login"
expect "anna → anna"  "$(access "$jar_anna" "$(printf $V anna)/api/config")"  "DATA"
expect "ben  → ben"   "$(access "$jar_ben"  "$(printf $V ben)/api/config")"   "DATA"
expect "anna → ben"   "$(access "$jar_anna" "$(printf $V ben)/api/config")"   "DENIED"
expect "ben  → anna"  "$(access "$jar_ben"  "$(printf $V anna)/api/config")"  "DENIED"
expect "anna (reader) → firma web" "$(access "$jar_anna" "$(printf $V firma)/api/config")" "DENIED"
expect "ben (writer) → firma web"  "$(access "$jar_ben"  "$(printf $V firma)/api/config")" "DATA"
expect "anna → metamcp admin" "$(access "$jar_anna" http://mcp.localhost:$P/api/health)" "DENIED"

echo "== 3. Header forgery through Traefik"
# Vaults trust X-authentik-username in guarded mode (LBV2-9); section 3b checks what they receive.
expect "anna → ben with forged X-authentik-username: ben" \
  "$(access "$jar_anna" "$(printf $V ben)/api/config" -H 'X-authentik-username: ben')" "DENIED"
expect "anna → own vault with wrong X-Vault-Proxy-Secret (Traefik must overwrite)" \
  "$(code -b "$jar_anna" -H 'X-Vault-Proxy-Secret: wrong-wrong-wrong-wrong-wrong-wrong' "$(printf $V anna)/api/config")" "200"
expect "anon → ben with ben's real proxy secret (secret alone is not a login)" \
  "$(code -H @"$(hfile "X-Vault-Proxy-Secret: $PROXY_SECRET_BEN")" "$(printf $V ben)/api/config")" "302"

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

echo "== 3c. Vault-side admin groups and secret masking (LBV2-9, end to end through Traefik)"
# carl: web access to the company vault (vault-firma-write) but not in vault-firma-admin.
jar_carl=$(mktemp)
tests/login.sh "$jar_carl" "$(printf $V firma)/" carl "$DEMO_PASS_CARL" || bad "carl login"
put() { # put <jar> <vault> <path> <json> [extra curl args] → HTTP status
  local jar=$1 v=$2 p=$3 json=$4; shift 4
  curl -s -o /dev/null -w '%{http_code}' -b "$jar" -X "${METHOD:-PUT}" -H 'content-type: application/json' "$@" -d "$json" "$(printf $V "$v")$p"
}
expect "carl (firma writer, no admin) → firma GET /api/config" "$(access "$jar_carl" "$(printf $V firma)/api/config")" "DATA"
expect "carl → firma PUT /api/config" "$(put "$jar_carl" firma /api/config '{}')" "403"
expect "carl → firma PUT /api/config with forged X-authentik-groups: vault-firma-admin|lokyy-admins" \
  "$(put "$jar_carl" firma /api/config '{}' -H 'X-authentik-groups: vault-firma-admin|lokyy-admins')" "403"
expect "carl → firma POST /api/config/test" "$(METHOD=POST put "$jar_carl" firma /api/config/test '{}')" "403"
expect "anna (vault-anna-admin) → own vault PUT /api/config" "$(put "$jar_anna" anna /api/config '{}')" "200"
test_key="isolation-test-key-$RANDOM$RANDOM"
expect "ben (vault-firma-admin) → firma PUT /api/config with an API key" \
  "$(put "$jar_ben" firma /api/config "{\"apiKey\":\"$test_key\"}")" "200"
cfg=$(curl -s -b "$jar_carl" "$(printf $V firma)/api/config")
expect "firma GET /api/config masks the stored key (as carl)" "$(jq -r '"\(.apiKey)/\(.hasApiKey)"' <<<"$cfg")" '\*\*\*\*\*\*\*\*/true'
expect "firma GET /api/config never contains the key" "$([[ $cfg == *"$test_key"* ]] && echo LEAKED || echo masked)" "masked"
expect "ben clears the test key again" "$(put "$jar_ben" firma /api/config '{"apiKey":""}')" "200"
expect "capture disabled (MINDBASE_DISABLE_CAPTURE): ben → firma /api/devices" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar_ben" "$(printf $V firma)/api/devices")" "404"
rm -f "$jar_carl"
for v in anna ben firma; do
  expect "vault-$v: SSRF guard not relaxed (MINDBASE_ALLOW_PRIVATE_FETCH unset)" \
    "$(docker compose exec -T "vault-$v" printenv MINDBASE_ALLOW_PRIVATE_FETCH >/dev/null 2>&1 && echo SET || echo unset)" "unset"
done

echo "== 4. Direct container access bypassing Traefik"
in_c() { docker compose exec -T "$1" sh -c "$2" 2>/dev/null; }
# in_ct <container> <token> <command>: the bearer header reaches the container via stdin (file $h), never argv
in_ct() { printf 'authorization: Bearer %s\n' "$2" | docker compose exec -T "$1" sh -c "umask 077; h=\$(mktemp); cat >\"\$h\"; $3; rm -f \"\$h\"" 2>/dev/null; }
expect "metamcp → vault-anna web port 4321 (only MCP is connected through vault-connector)" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://mcp.vault-anna:4321/api/config || true")" "000"
expect "metamcp → vault-anna:4322 without token" \
  "$(in_c metamcp "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://mcp.vault-anna:4322/mcp")" "401"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
expect "metamcp → vault-anna:4322 with anna's token (intended path)" \
  "$(in_ct metamcp "$MCP_TOKEN_ANNA" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\$h -d '$init' http://mcp.vault-anna:4322/mcp")" "200"
expect "metamcp → vault-ben:4322 with anna's token" \
  "$(in_ct metamcp "$MCP_TOKEN_ANNA" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H @\$h http://mcp.vault-ben:4322/mcp")" "401"

echo "== 4b. Company vault read-only profile (fail-closed, enforced in the vault)"
mcp_post() { # mcp_post <token> <json> [session] -> writes headers+body to stdout
  in_ct metamcp "$1" "curl -s -i --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\$h ${3:+-H 'mcp-session-id: $3'} -d '$2' http://mcp.vault-firma:4322/mcp"
}
ro_init=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" "$init")
ro_sid=$(grep -i '^mcp-session-id:' <<<"$ro_init" | awk '{print $2}' | tr -d '\r')
expect "firma read-only token opens a session" "$([[ -n "$ro_sid" ]] && echo yes || echo no)" "yes"
mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$ro_sid" >/dev/null
ro_tools=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$ro_sid" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l)
expect "firma read-only tools/list has exactly 13 tools" "$ro_tools" "13"
ro_write=$(mcp_post "$MCP_READONLY_TOKEN_FIRMA" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"reader-attack"}}}' "$ro_sid" | grep -o 'Tool not available' | head -1)
expect "firma read-only create_note rejected" "$ro_write" "Tool not available"
expect "firma read-only session refuses full token (403)" \
  "$(in_ct metamcp "$MCP_TOKEN_FIRMA" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\$h -H 'mcp-session-id: $ro_sid' -d '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\"}' http://mcp.vault-firma:4322/mcp")" "403"
full_tools=$(in_ct metamcp "$MCP_TOKEN_FIRMA" "curl -s --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\$h -D /tmp/h -d '$init' http://mcp.vault-firma:4322/mcp >/dev/null; sid=\$(grep -i '^mcp-session-id:' /tmp/h | awk '{print \$2}' | tr -d '\r'); curl -s --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\$h -H \"mcp-session-id: \$sid\" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' http://mcp.vault-firma:4322/mcp" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l)
expect "firma full token tools/list has all 50 tools" "$full_tools" "50"

echo "== 5. Lateral movement from a vault container (e.g. via SSRF)"
for target in mcp.vault-ben:4322 vault-ben:4321 vault-ben:4322 vault-firma:4321 vault-firma:4322 authentik-server:9000 authentik-db:5432 metamcp-db:5432; do
  expect "vault-anna → $target" \
    "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://$target/ || true")" "000"
done
# MetaMCP and the vaults share no network (M2): a vault reaches neither MetaMCP (API, session listing,
# sign-up) nor vault-connector, which listens only on mcp-upstream.
for p in metamcp/health/sessions metamcp/health trpc/frontend.mcpServers.list api/auth/sign-up/email; do
  expect "vault-anna → metamcp:12008/$p unreachable" \
    "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://metamcp:12008/$p || true")" "000"
done
for ip in $(docker inspect "${STACK}-vault-connector-1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}') $(docker inspect "${STACK}-metamcp-1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'); do
  for port in 4322 12008; do
    expect "vault-anna → $ip:$port (vault-connector / metamcp by IP)" \
      "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://$ip:$port/ || true")" "000"
  done
done
for v in anna ben firma; do
  expect "vault-$v does not mount the model cache /models (embeddings via the shared service, LBV2-26)" \
    "$(docker inspect "${STACK}-vault-$v-1" --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -c '/models')" "0"
done
expect "embed cannot write the shared model cache /models (M3)" \
  "$(docker compose exec -T embed sh -c 'touch /models/.probe 2>/dev/null && echo WRITABLE || echo read-only' | tr -d '\r')" "read-only"
expect "OCR works; tesseract data cached in the vault's own home volume (MINDBASE_MODEL_CACHE, LBV2-14)" \
  "$(docker compose exec -T vault-anna sh -c 'cat >/tmp/ocr-probe.mjs' <tests/lib/ocr-probe.mjs; OCR_PNG_B64=$(base64 -w0 tests/fixtures/ocr-lokyy.png) docker compose exec -T -e OCR_PNG_B64 vault-anna node /tmp/ocr-probe.mjs 2>&1 | tail -1 | tr -d '\r')" "cache=MINDBASE_MODEL_CACHE text=LOKYY 4711"
expect "tesseract cache is persistent and per vault (named volume vault-anna-home)" \
  "$(docker inspect "${STACK}-vault-anna-1" --format '{{range .Mounts}}{{if eq .Destination "/home/vault"}}{{.Type}}:{{.Name}}{{end}}{{end}}')" "volume:${STACK}_vault-anna-home"
expect "vault-ben has no access to anna's tesseract cache" \
  "$(docker compose exec -T vault-ben sh -c 'ls /home/vault/tesseract/eng.traineddata 2>/dev/null | wc -l' | tr -d ' \r')" "0"
for v in anna ben firma; do
  expect "vault-$v embedder runs with MINDBASE_MODELS_OFFLINE=1 (no downloads in code, LBV2-24)" "$(docker compose exec -T "vault-$v" printenv MINDBASE_MODELS_OFFLINE | tr -d '\r')" "1"
done
expect "embed service loads the model offline from /models; unlisted models are never downloaded (allowRemoteModels=false)" \
  "$(docker run --rm --network none -v "${STACK}_models:/models:ro" -v "$PWD/models/offline.mjs:/lokyy/offline.mjs:ro" -v "$PWD/tests/lib/embed-offline-probe.mjs:/probe.mjs:ro" \
      -e NODE_OPTIONS=--import=/lokyy/offline.mjs --entrypoint node "lokyy-embed:$TAG" /probe.mjs 2>/dev/null | tail -1 | tr -d '\r')" "allowRemote=false dim=1024 unlisted=refused"
expect "model-prefetch verified the pinned model (sha256 manifest)" \
  "$(docker compose logs model-prefetch 2>/dev/null | grep -c 'verified (4 files, sha256)')" "[1-9][0-9]*"
expect "embed starts only after a successful model-prefetch" \
  "$(docker compose config --format json | jq -r '.services.embed.depends_on["model-prefetch"].condition')" "service_completed_successfully"
for v in anna ben firma; do
  expect "vault-$v starts only after the embed service is healthy" \
    "$(docker compose config --format json | jq -r --arg s "vault-$v" '.services[$s].depends_on.embed.condition')" "service_healthy"
done
# Tampered model file: verification must fail (vaults would not start). Checked on a copy, offline.
tamper=$(mktemp -d)
docker compose exec -T embed sh -c 'cd /models && tar cf - Xenova/bge-m3/config.json Xenova/bge-m3/tokenizer_config.json' | tar xf - -C "$tamper"
printf ' ' >>"$tamper/Xenova/bge-m3/config.json"
chmod -R a+rX "$tamper"
expect "model-prefetch fails closed on a tampered model file" \
  "$(docker run --rm --network none --entrypoint node -e PREFETCH_VERIFY_ONLY=1 -v "$tamper:/models:ro" -v "$PWD/models:/prefetch:ro" "lokyy-brain-v2:$TAG" /prefetch/prefetch.mjs >/dev/null 2>"$tamper.err"; echo "exit=$? $(grep -o 'checksum mismatch config.json' "$tamper.err")")" "exit=1 checksum mismatch config.json"
rm -rf "$tamper" "$tamper.err"
expect "model cache prefilled by model-prefetch" \
  "$(docker compose exec -T embed sh -c 'find /models -name "*.onnx" | head -1 | grep -q . && echo present || echo missing' | tr -d '\r')" "present"
expect "vault-anna → traefik → ben (no session)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: ben.vault.localhost:$P' http://traefik/api/config")" "302"
expect "vault-anna → internet (EUrouter must stay reachable)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://www.eurouter.ai/")" "200|301|302|307|308"
expect "vault-anna → EUrouter API host (LLM base URL)" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.eurouter.ai/api/v1/models")" "200"

echo "== 5b. Network topology (name-independent)"
members() { docker network inspect "${STACK}_$1" --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | sed -E "s/^${STACK}-//; s/-[0-9]+\$//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//'; }
for v in anna ben firma; do
  expect "web-$v members" "$(members web-$v)" "traefik vault-$v"
  expect "mcp-$v members" "$(members mcp-$v)" "vault-$v vault-connector|vault-connector vault-$v"
  expect "embed-$v members" "$(members embed-$v)" "embed vault-$v"
  expect "vault-$v networks" "$(docker inspect "${STACK}-vault-$v-1" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed "s/^${STACK}_//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')" "egress embed-$v mcp-$v web-$v"
done
expect "mcp-upstream members (no vault)" "$(members mcp-upstream)" "metamcp vault-connector"
expect "metamcp networks (no vault network)" "$(docker inspect "${STACK}-metamcp-1" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed "s/^${STACK}_//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')" "edge mcp-upstream metamcp-internal"
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

echo "== 5d. Shared embedding service (LBV2-26)"
# embed_post <vault-container> <token|-> <json> [extra curl args] → "<status> <body…>" as seen from inside that vault
embed_post() {
  local c=$1 tok=$2 json=$3; shift 3
  if [[ $tok == - ]]; then
    in_c "$c" "curl -s -w ' %{http_code}' --max-time 60 -X POST -H 'content-type: application/json' $* -d '$json' http://embed:8080/embed" | awk '{print $NF" "substr($0,1,length($0)-length($NF)-1)}'
  else
    in_ct "$c" "$tok" "curl -s -w ' %{http_code}' --max-time 60 -X POST -H 'content-type: application/json' -H @\$h $* -d '$json' http://embed:8080/embed" | awk '{print $NF" "substr($0,1,length($0)-length($NF)-1)}'
  fi
}
marker="isolation-marker-$RANDOM$RANDOM"
for v in anna ben firma; do
  tokvar="EMBED_TOKEN_${v^^}"
  out=$(embed_post "vault-$v" "${!tokvar}" "{\"texts\":[\"$marker $v\"]}")
  expect "vault-$v → embed with its own token (1024-dim vector)" "${out%% *} $(jq -r '.dim' <<<"${out#* }" 2>/dev/null)" "200 1024"
done
expect "vault-anna → embed with ben's token (bound to ben's network)" "$(embed_post vault-anna "$EMBED_TOKEN_BEN" '{"texts":["x"]}' | cut -d' ' -f1)" "401"
expect "vault-ben → embed with firma's token" "$(embed_post vault-ben "$EMBED_TOKEN_FIRMA" '{"texts":["x"]}' | cut -d' ' -f1)" "401"
expect "vault-anna → embed without token" "$(embed_post vault-anna - '{"texts":["x"]}' | cut -d' ' -f1)" "401"
expect "vault-anna → embed with a wrong token" "$(embed_post vault-anna "wrong-$RANDOM-token" '{"texts":["x"]}' | cut -d' ' -f1)" "401"
expect "vault-anna → embed: too many texts rejected" \
  "$(embed_post vault-anna "$EMBED_TOKEN_ANNA" "{\"texts\":$(jq -cn '[range(40)|"t"]')}" | cut -d' ' -f1)" "400"
expect "vault-anna → embed: over-long text rejected" \
  "$(embed_post vault-anna "$EMBED_TOKEN_ANNA" "{\"texts\":[\"$(head -c 8001 /dev/zero | tr '\0' a)\"]}" | cut -d' ' -f1)" "400"
# embed is not a proxy: absolute-form URLs, Host headers and CONNECT never reach another vault
expect "vault-anna → embed as HTTP proxy to vault-ben" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -x http://embed:8080 http://vault-ben:4321/api/config || true")" "404"
expect "vault-anna → embed CONNECT tunnel to vault-ben:4322" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -p -x http://embed:8080 http://vault-ben:4322/mcp || true")" "000|400|404|405"
expect "vault-anna → embed with Host: upstream.vault-ben" \
  "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: upstream.vault-ben:4322' http://embed:8080/mcp || true")" "404"
# Other vaults' embed networks are not routed from vault-anna
for n in embed-ben embed-firma; do
  ip=$(docker inspect "${STACK}-embed-1" --format "{{(index .NetworkSettings.Networks \"${STACK}_$n\").IPAddress}}")
  expect "vault-anna → embed's address on $n ($ip:8080)" \
    "$(in_c vault-anna "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://$ip:8080/healthz || true")" "000"
done
expect "embed has no outbound network (internet)" \
  "$(docker compose exec -T embed node -e "fetch('https://api.eurouter.ai/',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('REACHED'),()=>console.log('blocked'))" | tr -d '\r')" "blocked"
expect "embed has no route to a public IP" \
  "$(docker compose exec -T embed node -e "require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>{console.log('REACHED');process.exit()}).on('error',()=>{console.log('blocked');process.exit()}).on('timeout',()=>{console.log('blocked');process.exit()})" | tr -d '\r')" "blocked"
for n in embed-anna embed-ben embed-firma; do
  expect "$n is internal" "$(docker network inspect "${STACK}_$n" --format '{{.Internal}}')" "true"
done
expect "embed networks (only the per-vault embed networks)" \
  "$(docker inspect "${STACK}-embed-1" --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed "s/^${STACK}_//" | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')" "embed-anna embed-ben embed-firma"
expect "embed hardening: read-only rootfs, no capabilities, no-new-privileges, memory limit" \
  "$(docker inspect "${STACK}-embed-1" --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{gt .HostConfig.Memory 0}}')" "true \[ALL\] \[no-new-privileges:true\] true"
expect "embed does not forward packets between vault networks (net.ipv4.ip_forward=0)" \
  "$(docker compose exec -T embed cat /proc/sys/net/ipv4/ip_forward | tr -d '\r')" "0"
expect "embed has a pids limit" "$(docker inspect "${STACK}-embed-1" --format '{{.HostConfig.PidsLimit}}')" "[1-9][0-9]*"
expect "embed runs as non-root" "$(docker compose exec -T embed id -u | tr -d '\r')" "[1-9][0-9]*"
expect "embed's root filesystem is not writable" \
  "$(docker compose exec -T embed sh -c 'touch /app/x 2>/dev/null && echo WRITABLE || echo read-only' | tr -d '\r')" "read-only"
expect "embed holds only token hashes (no plain token in its environment)" \
  "$(docker compose exec -T embed env | grep -cF "$EMBED_TOKEN_ANNA")" "0"
expect "embed logs contain no text content" "$(docker compose logs embed 2>/dev/null | grep -c "$marker")" "0"
expect "embed logs contain no token" "$(docker compose logs embed 2>/dev/null | grep -cF -e "$EMBED_TOKEN_ANNA" -e "$EMBED_TOKEN_BEN")" "0"
expect "embed logs attribute requests per vault" "$(docker compose logs embed 2>/dev/null | grep -c 'vault=ben texts=1 status=200')" "[1-9][0-9]*"
for v in anna ben firma; do
  expect "vault-$v has its own embed token and the service URL" \
    "$(docker compose exec -T "vault-$v" sh -c 'echo "$MINDBASE_EMBED_URL $([ -n "$MINDBASE_EMBED_TOKEN" ] && echo token)"' | tr -d '\r')" "http://embed:8080 token"
done
expect "vault search goes through the embed service (anna, hybrid search via Traefik)" \
  "$(before=$(docker compose logs embed 2>/dev/null | grep -c 'vault=anna texts=1 status=200'); curl -s -o /dev/null -b "$jar_anna" -H 'content-type: application/json' -d '{"q":"isolation embedding probe"}' "$(printf $V anna)/api/search/hybrid"; sleep 1; after=$(docker compose logs embed 2>/dev/null | grep -c 'vault=anna texts=1 status=200'); echo $((after - before)))" "[1-9][0-9]*"

echo "== 5c. Traefik scope (LOW-2)"
expect "MetaMCP admin route never serves /metamcp/health/sessions" \
  "$(code http://mcp.localhost:$P/metamcp/health/sessions)" "404"
expect "MetaMCP admin route never serves /metamcp/health/sessions (admin-looking session cookie irrelevant)" \
  "$(code -b "$jar_ben" http://mcp.localhost:$P/metamcp/health/sessions)" "404"
foreign=$(docker run -d --rm --network "${STACK}_edge" --label traefik.enable=true \
  --label 'traefik.http.routers.lokyy-foreign-probe.rule=Host(`foreign.localhost`)' \
  --label traefik.http.services.lokyy-foreign-probe.loadbalancer.server.port=80 traefik/whoami:v1.11.0 2>/dev/null)
sleep 3
expect "labels of a container outside this compose project are ignored" "$(code http://foreign.localhost:$P/)" "404"
docker rm -f "$foreign" >/dev/null 2>&1

echo "== 6. Nothing but Traefik is published on the host"
published=$(docker compose ps --format json | jq -r 'select(.Service != "traefik") | .Service as $s | (.Publishers // [])[] | select(.PublishedPort != 0) | "\($s):\(.PublishedPort)"' || true)
[[ -z "$published" ]] && ok "only traefik publishes ports" || bad "published ports: $published"
expect "host → 127.0.0.1:$P bound to loopback only" \
  "$(docker compose port traefik 80 | cut -d: -f1)" "127\.0\.0\.1"

echo
echo "RESULT: $pass passed, $fail failed, $xfailed expected failures (known open findings), $xpassed unexpectedly passing"
[[ $fail -eq 0 ]]
