#!/usr/bin/env bash
# LBV2-4 — attack tests for the per-user MetaMCP endpoints (provisioned by metamcp/provision.sh).
# Everything goes through Traefik like a real AI client: http://mcp.localhost:18080/metamcp/<user>/mcp
# Run from deploy/stack/ with the stack up: tests/metamcp-attacks.sh
# Side effects: rotates anna's API key, temporarily deprovisions ben, writes test notes into
# anna's and the company vault (slugs mcpattack-*). secrets/metamcp-clients.json is rewritten.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
tests/wait-ready.sh "${WAIT_TIMEOUT:-300}" || exit 1

pass=0 fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
expect() { # expect <name> <actual> <allowed-regex>
  if [[ "$2" =~ ^($3)$ ]]; then ok "$1 → $2"; else bad "$1 → $2 (expected $3)"; fi
}
CLIENTS=secrets/metamcp-clients.json
BASE=http://mcp.localhost:18080/metamcp
key() { jq -r --arg u "$1" '.users[] | select(.username == $u) | .apiKey' "$CLIENTS"; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

provision() { metamcp/provision.sh "$@" >"$tmp/provision.log" 2>&1 || { cat "$tmp/provision.log" >&2; return 1; }; }

# --- minimal MCP client (Streamable HTTP) -------------------------------------------------
# rpc <endpoint-user> <auth-mode:key|bearer|query|none> <key> <session> <json>
# Sets STATUS, SID (response mcp-session-id), BODY (JSON-RPC message, SSE unwrapped).
rpc() {
  local ep=$1 mode=$2 k=$3 sid=$4 json=$5 url="$BASE/$1/mcp" args=()
  case $mode in
    key)    args+=(-H "x-api-key: $k") ;;
    bearer) args+=(-H "authorization: Bearer $k") ;;
    query)  url="$url?api_key=$k" ;;
  esac
  [[ -n $sid ]] && args+=(-H "mcp-session-id: $sid")
  STATUS=$(curl -s --max-time 60 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    "${args[@]}" -d "$json" "$url")
  SID=$(grep -i '^mcp-session-id:' "$tmp/h" | awk '{print $2}' | tr -d '\r')
  if grep -q '^data: ' "$tmp/b"; then BODY=$(sed -n 's/^data: //p' "$tmp/b" | tail -1); else BODY=$(cat "$tmp/b"); fi
}
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"attack","version":"0"}}}'
# open <user> <key> → echoes session id
open() {
  rpc "$1" key "$2" "" "$INIT"; local sid=$SID
  [[ $STATUS == 200 && -n $sid ]] || { echo ""; return; }
  rpc "$1" key "$2" "$sid" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo "$sid"
}
tools() { # tools <user> <key> <sid> → tool names, one per line
  rpc "$1" key "$2" "$3" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  jq -r '.result.tools[].name' <<<"$BODY" 2>/dev/null | sort
}
call() { # call <user> <key> <sid> <tool> <arguments-json> → OK | REJECTED:<reason>
  local req; req=$(jq -cn --arg n "$4" --argjson a "$5" '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:$n,arguments:$a}}')
  rpc "$1" key "$2" "$3" "$req"
  if [[ $STATUS != 200 ]]; then echo "REJECTED:http-$STATUS"
  elif jq -e '.error' <<<"$BODY" >/dev/null 2>&1; then echo "REJECTED:$(jq -r '.error.message' <<<"$BODY" | head -c 60)"
  elif jq -e '.result.isError == true' <<<"$BODY" >/dev/null 2>&1; then echo "REJECTED:$(jq -r '.result.content[0].text' <<<"$BODY" | head -c 60)"
  else echo OK; fi
}
# found <vault> <marker> → number of files in the vault's data dir containing the marker
found() { docker compose exec -T "vault-$1" sh -c "grep -rl -- '$2' /data 2>/dev/null | wc -l" | tr -d ' \r'; }
count() { docker compose exec -T metamcp-db psql -U metamcp -d metamcp -tAc "$1" | tr -d '\r'; }
state() { count "select (select count(*) from users)||'/'||(select count(*) from mcp_servers)||'/'||(select count(*) from namespaces)||'/'||(select count(*) from endpoints)||'/'||(select count(*) from api_keys)"; }

echo "== 0. Provisioning is idempotent"
provision || { bad "provisioning failed"; echo "RESULT: $pass passed, $fail failed"; exit 1; }
expect "clients file is mode 600" "$(stat -c %a "$CLIENTS")" "600"
expect "clients file is ignored by git" "$(git check-ignore -q "$CLIENTS" && echo ignored || echo TRACKED)" "ignored"
state1=$(state) keys1=$(jq -c '[.users[].apiKey]' "$CLIENTS")
provision
expect "re-run creates nothing (users/servers/namespaces/endpoints/keys $state1)" "$(state)" "$state1"
expect "re-run keeps API keys" "$([[ $(jq -c '[.users[].apiKey]' "$CLIENTS") == "$keys1" ]] && echo same || echo changed)" "same"
expect "provisioned objects are private (no public server/namespace/endpoint/key)" \
  "$(count "select (select count(*) from mcp_servers where user_id is null)+(select count(*) from namespaces where user_id is null)+(select count(*) from endpoints where user_id is null)+(select count(*) from api_keys where user_id is null)")" "0"
expect "provisioned users keep no login method or session after the run" \
  "$(count "select (select count(*) from accounts where user_id like 'lokyy-%')+(select count(*) from sessions where user_id like 'lokyy-%')")" "0"

ANNA=$(key anna) BEN=$(key ben)
echo "== 1. Endpoint authentication through Traefik"
rpc anna none "" "" "$INIT";        expect "anna endpoint without key" "$STATUS" "401"
rpc anna key "wrong-$RANDOM" "" "$INIT"; expect "anna endpoint with invented key" "$STATUS" "401"
rpc ben key "$ANNA" "" "$INIT";     expect "anna's key on ben's endpoint (x-api-key)" "$STATUS" "403"
rpc ben bearer "$ANNA" "" "$INIT";  expect "anna's key on ben's endpoint (Bearer)" "$STATUS" "403"
rpc ben query "$ANNA" "" "$INIT";   expect "anna's key on ben's endpoint (query param, disabled)" "$STATUS" "401"
rpc ben none "" "" "$INIT";         expect "ben's endpoint without key" "$STATUS" "401"
rpc anna key "$BEN" "" "$INIT";     expect "ben's key on anna's endpoint" "$STATUS" "403"
# Anything but /metamcp/<name>/mcp falls through to the Authentik-protected admin router (302 to login).
expect "endpoint catalogue GET /metamcp/ not routed to MetaMCP" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "302"
for p in sse message api/openapi.json api/tools/x; do
  expect "only /mcp is routed: /metamcp/anna/$p" "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $ANNA" "$BASE/anna/$p")" "302"
done

echo "== 2. Tool visibility per user"
sa=$(open anna "$ANNA"); sb=$(open ben "$BEN")
expect "anna opens a session with her key" "$([[ -n $sa ]] && echo yes || echo no)" "yes"
expect "ben opens a session with his key" "$([[ -n $sb ]] && echo yes || echo no)" "yes"
tools anna "$ANNA" "$sa" >"$tmp/anna.tools"; tools ben "$BEN" "$sb" >"$tmp/ben.tools"
allow=$(sed -n "/^export const READ_ONLY_TOOL_NAMES/,/]);/p" ../../apps/mcp/src/access.ts | grep -oE "'[a-z_]+'" | tr -d "'" | sort)
expect "anna sees only her vault + company servers" "$(sed 's/__.*//' "$tmp/anna.tools" | sort -u | tr '\n' ' ' | sed 's/ $//')" "anna-firma anna-vault"
expect "anna's company tools == vault read allowlist (13)" \
  "$([[ "$(sed -n 's/^anna-firma__//p' "$tmp/anna.tools")" == "$allow" ]] && echo "equal $(grep -c '^anna-firma__' "$tmp/anna.tools")" || echo "DIFF: $(sed -n 's/^anna-firma__//p' "$tmp/anna.tools" | tr '\n' ' ')")" "equal 13"
expect "anna's own vault exposes the full tool set" "$(grep -c '^anna-vault__' "$tmp/anna.tools")" "50"
expect "ben sees only his vault + company servers" "$(sed 's/__.*//' "$tmp/ben.tools" | sort -u | tr '\n' ' ' | sed 's/ $//')" "ben-firma ben-vault"
expect "ben's company tools are the full set (writer)" "$(grep -c '^ben-firma__' "$tmp/ben.tools")" "50"
expect "no personal vault of another user in anna's list" "$(grep -c '^ben-' "$tmp/anna.tools")" "0"
expect "no personal vault of another user in ben's list" "$(grep -c '^anna-' "$tmp/ben.tools")" "0"

echo "== 3. Reader cannot write to the company vault (any tool name variant)"
m="mcpattack-reader-$RANDOM$RANDOM"
note() { jq -cn --arg s "$1" '{slug:$s,title:$s,content:("marker " + $s)}'; }
for name in anna-firma__create_note ben-firma__create_note create_note firma__create_note vault-firma__create_note \
            ANNA-FIRMA__create_note anna-firma__Create_Note anna-firma____create_note " anna-firma__create_note" \
            anna-firma__anna-vault__create_note anna-firma__ben-firma__create_note "anna-firma__create_note " \
            anna-firma__append_to_page anna-firma__delete_page ben-vault__create_note; do
  expect "anna calls '$name'" "$(call anna "$ANNA" "$sa" "$name" "$(note "$m")" | cut -d: -f1)" "REJECTED"
done
expect "no marker written to the company vault" "$(found firma "$m")" "0"
expect "no marker written to ben's vault" "$(found ben "$m")" "0"
m2="mcpattack-own-$RANDOM$RANDOM"
expect "anna writes to her own vault (control)" "$(call anna "$ANNA" "$sa" anna-vault__create_note "$(note "$m2")")" "OK"
expect "anna's note landed in her vault only" "$(found anna "$m2")/$(found firma "$m2")/$(found ben "$m2")" "[1-9][0-9]*/0/0"

echo "== 4. Writer can write to the company vault"
m3="mcpattack-writer-$RANDOM$RANDOM"
expect "ben calls ben-firma__create_note" "$(call ben "$BEN" "$sb" ben-firma__create_note "$(note "$m3")")" "OK"
expect "ben's note landed in the company vault" "$([[ $(found firma "$m3") -ge 1 ]] && echo yes || echo no)" "yes"
expect "ben's session cannot use anna's server names" "$(call ben "$BEN" "$sb" anna-vault__create_note "$(note "$m3-x")" | cut -d: -f1)" "REJECTED"

echo "== 5. MetaMCP fail-open cases cannot turn into a company write (vault enforces)"
# Credentials MetaMCP actually holds: a reader's company server must carry the read-only token, never the full one.
dbq() { docker compose exec -T -e MCP_TOKEN_FIRMA -e MCP_READONLY_TOKEN_FIRMA metamcp-db psql -U metamcp -d metamcp -tA -v ON_ERROR_STOP=1 \
  <<<"\\getenv full MCP_TOKEN_FIRMA
\\getenv ro MCP_READONLY_TOKEN_FIRMA
$1;" | tr -d '\r'; }
expect "anna-firma stores the company READ-ONLY token" "$(dbq "select count(*) from mcp_servers where name='anna-firma' and bearer_token = :'ro'")" "1"
expect "no server in anna's namespace stores the full company token" \
  "$(dbq "select count(*) from mcp_servers s join namespace_server_mappings m on m.mcp_server_uuid = s.uuid join namespaces n on n.uuid = m.namespace_uuid where n.user_id = 'lokyy-anna' and s.bearer_token = :'full'")" "0"
# Unknown mapping: remove every tool status row of anna's namespace (MetaMCP then allows everything by default).
count "delete from namespace_tool_mappings where namespace_uuid in (select uuid from namespaces where user_id = 'lokyy-anna')" >/dev/null
expect "without MetaMCP tool mappings: anna-firma__create_note" "$(call anna "$ANNA" "$sa" anna-firma__create_note "$(note "$m")" | cut -d: -f1)" "REJECTED"
# Unparsable name: the filter lets it through; routing must still fail.
expect "unparsable tool name (no prefix) with filter bypassed" "$(call anna "$ANNA" "$sa" create_note "$(note "$m")" | cut -d: -f1)" "REJECTED"
# Worst case: MetaMCP forwards any call. Replay every non-read tool directly against the vault with the exact
# credential MetaMCP stores for anna-firma.
full_names=$(sed -n 's/^ben-firma__//p' "$tmp/ben.tools")
write_names=$(comm -23 <(echo "$full_names") <(echo "$allow") | tr '\n' ' ')
replay=$(docker compose exec -T -w /app/apps/backend -e WRITE_TOOLS="$write_names" -e MARKER="$m" metamcp node --input-type=module - <tests/lib/replay-reader-credential.mjs 2>&1)
expect "replay: non-read tools called with anna-firma's stored credential" "$(tail -1 <<<"$replay")" "rejected [0-9]+/[0-9]+ accepted 0"
expect "no marker written to the company vault after replay" "$(found firma "$m")" "0"
provision  # restore tool mappings

echo "== 6. Key rotation and user removal"
old=$ANNA
provision --rotate anna
ANNA=$(key anna)
expect "rotation issued a new key" "$([[ -n $ANNA && $ANNA != "$old" ]] && echo new || echo same)" "new"
rpc anna key "$old" "" "$INIT";     expect "old anna key after rotation" "$STATUS" "401"
rpc anna key "$old" "$sa" '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'; expect "old key on an already open session" "$STATUS" "401"
expect "new anna key works" "$([[ -n $(open anna "$ANNA") ]] && echo yes || echo no)" "yes"
jq '.users |= map(select(.username != "ben"))' users.json >"$tmp/users-without-ben.json"
USERS_FILE="$tmp/users-without-ben.json" provision
rpc ben key "$BEN" "" "$INIT";      expect "removed user ben: his key on his old endpoint" "$STATUS" "401|404"
rpc ben key "$BEN" "$sb" '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'; expect "removed user ben: already open session" "$STATUS" "401|404"
expect "removed user ben: MetaMCP objects deleted" "$(count "select count(*) from users where id='lokyy-ben'")/$(count "select count(*) from api_keys where user_id='lokyy-ben'")" "0/0"
rpc anna key "$BEN" "" "$INIT";     expect "removed user ben: his key on anna's endpoint" "$STATUS" "401"
provision
BEN=$(key ben)
expect "re-added ben gets a working (new) key" "$([[ -n $(open ben "$BEN") ]] && echo yes || echo no)" "yes"

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
