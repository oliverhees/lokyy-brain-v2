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
# xfail <name> <actual> <allowed-regex> <known issue>: a check that is EXPECTED to fail until a known finding is fixed.
# It is reported (XFAIL), never hidden; if it starts passing it is reported as XPASS so the marker gets removed.
xfailed=0 xpassed=0
xfail() {
  if [[ "$2" =~ ^($3)$ ]]; then echo "XPASS $1 → $2 (known issue $4 seems fixed: turn this into a normal check)"; xpassed=$((xpassed+1))
  else echo "XFAIL $1 → $2 (expected $3; KNOWN $4)"; xfailed=$((xfailed+1)); fi
}
expect() { # expect <name> <actual> <allowed-regex>
  if [[ "$2" =~ ^($3)$ ]]; then ok "$1 → $2"; else bad "$1 → $2 (expected $3)"; fi
}
CLIENTS=secrets/metamcp-clients.json
BASE=http://mcp.localhost:18080/metamcp
key() { jq -r --arg u "$1" '.users[] | select(.username == $u) | .apiKey' "$CLIENTS"; }
umask 077
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

provision() { metamcp/provision.sh "$@" >"$tmp/provision.log" 2>&1 || { cat "$tmp/provision.log" >&2; return 1; }; }

# --- minimal MCP client (Streamable HTTP) -------------------------------------------------
# rpc <endpoint-user> <auth-mode:key|bearer|query|none> <key> <session> <json>
# Sets STATUS, SID (response mcp-session-id), BODY (JSON-RPC message, SSE unwrapped).
rpc() {
  local ep=$1 mode=$2 k=$3 sid=$4 json=$5 url="$BASE/$1/mcp"
  # Keys go into a curl config file (mode 600), never into curl's argv.
  : >"$tmp/req.cfg"
  case $mode in
    key)    printf 'header = "x-api-key: %s"\n' "$k" >>"$tmp/req.cfg" ;;
    bearer) printf 'header = "authorization: Bearer %s"\n' "$k" >>"$tmp/req.cfg" ;;
    query)  url="$url?api_key=$k" ;;
  esac
  [[ -n $sid ]] && printf 'header = "mcp-session-id: %s"\n' "$sid" >>"$tmp/req.cfg"
  printf 'url = "%s"\n' "$url" >>"$tmp/req.cfg"
  STATUS=$(curl -s --max-time 60 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -K "$tmp/req.cfg" -d "$json")
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

sum_before=$(sha256sum "$CLIENTS")
bad_users() { jq "$1" users.json >"$tmp/bad-users.json"; USERS_FILE="$tmp/bad-users.json" metamcp/provision.sh >/dev/null 2>&1 && echo accepted || echo refused; }
expect "users file: two users on one vault refused" "$(bad_users '.users[1].vault = "anna" | .users[1].allowVaultNameMismatch = true')" "refused"
expect "users file: vault name != username refused" "$(bad_users '.users[0].vault = "ben" | .users[1].vault = "anna"')" "refused"
expect "users file: invalid companyVault refused" "$(bad_users '.companyVault = "../firma"')" "refused"
expect "refused runs leave the clients file unchanged" "$([[ $(sha256sum "$CLIENTS") == "$sum_before" ]] && echo same || echo changed)" "same"
expect "refused runs change no MetaMCP objects" "$(state)" "$state1"

ANNA=$(key anna) BEN=$(key ben)
echo "== 1. Endpoint authentication through Traefik"
rpc anna none "" "" "$INIT";        expect "anna endpoint without key" "$STATUS" "401"
rpc anna key "wrong-$RANDOM" "" "$INIT"; expect "anna endpoint with invented key" "$STATUS" "401"
rpc ben key "$ANNA" "" "$INIT";     expect "anna's key on ben's endpoint (x-api-key)" "$STATUS" "401"
rpc ben bearer "$ANNA" "" "$INIT";  expect "anna's key on ben's endpoint (Bearer)" "$STATUS" "401"
rpc ben query "$ANNA" "" "$INIT";   expect "anna's key on ben's endpoint (query param, disabled)" "$STATUS" "401"
rpc ben none "" "" "$INIT";         expect "ben's endpoint without key" "$STATUS" "401"
rpc nosuchuser key "$ANNA" "" "$INIT"; expect "unknown endpoint answers like a wrong key (no enumeration)" "$STATUS" "401"
rpc anna key "$BEN" "" "$INIT";     expect "ben's key on anna's endpoint" "$STATUS" "401"
# L1/M2: every rejection looks the same (status and body), so nothing can be enumerated and
# MetaMCP's "available_sessions" list never reaches a client.
bodies() { rpc "$@"; echo "$STATUS $(sha256sum <"$tmp/b" | cut -c1-16) $(wc -c <"$tmp/b")"; }
{
  bodies anna none "" "" "$INIT"
  bodies anna key "wrong-$RANDOM" "" "$INIT"
  bodies ben key "$ANNA" "" "$INIT"
  bodies nosuchuser key "$ANNA" "" "$INIT"
  bodies nosuchuser none "" "" "$INIT"
  bodies anna key "$ANNA" "00000000-0000-4000-8000-000000000000" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
} >"$tmp/rejections"
expect "all 6 rejection kinds identical (status, body hash, length)" "$(sort -u "$tmp/rejections" | wc -l)" "1"
rpc anna key "$ANNA" "00000000-0000-4000-8000-000000000000" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "valid key + invented session id: no session ids (UUIDs) in the response" \
  "$(grep -cE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$tmp/b")" "0"
# Anything but /metamcp/<name>/mcp falls through to the Authentik-protected admin router (302 to login).
expect "endpoint catalogue GET /metamcp/ not routed to MetaMCP" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "302"
for p in sse message api/openapi.json api/tools/x; do
  expect "only /mcp is routed: /metamcp/anna/$p" "$(curl -s -o /dev/null -w '%{http_code}' -K <(printf 'header = "x-api-key: %s"\n' "$ANNA") "$BASE/anna/$p")" "302"
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
rpc ben key "$BEN" "" "$INIT";      expect "removed user ben: his key on his old endpoint" "$STATUS" "401"
rpc ben key "$BEN" "$sb" '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'; expect "removed user ben: already open session" "$STATUS" "401"
expect "removed user ben: MetaMCP objects deleted" "$(count "select count(*) from users where id='lokyy-ben'")/$(count "select count(*) from api_keys where user_id='lokyy-ben'")" "0/0"
rpc anna key "$BEN" "" "$INIT";     expect "removed user ben: his key on anna's endpoint" "$STATUS" "401"
provision
BEN=$(key ben)
expect "re-added ben gets a working (new) key" "$([[ -n $(open ben "$BEN") ]] && echo yes || echo no)" "yes"

echo "== 7. Access changes end open sessions (M1)"
expect "MetaMCP session lifetime is finite (8 h)" "$(count "select value from config where id='SESSION_LIFETIME'")" "28800000"
sd=$(open ben "$BEN")
m4="mcpattack-demoted-$RANDOM$RANDOM" m4b="mcpattack-writer2-$RANDOM$RANDOM"
expect "ben (writer) writes to the company vault through his open session" \
  "$(call ben "$BEN" "$sd" ben-firma__create_note "$(note "$m4b")")" "OK"
jq '(.users[] | select(.username == "ben") | .role) = "reader"' users.json >"$tmp/users-ben-reader.json"
USERS_FILE="$tmp/users-ben-reader.json" provision
expect "demotion rotated ben's key" "$([[ $(key ben) != "$BEN" ]] && echo rotated || echo same)" "rotated"
expect "demoted ben: old key + open writer session → company write" \
  "$(call ben "$BEN" "$sd" ben-firma__create_note "$(note "$m4")" | cut -d: -f1)" "REJECTED"
expect "demoted ben: new key + old writer session → company write" \
  "$(call ben "$(key ben)" "$sd" ben-firma__create_note "$(note "$m4")" | cut -d: -f1)" "REJECTED"
sr=$(open ben "$(key ben)")
expect "demoted ben: new session → company write" \
  "$(call ben "$(key ben)" "$sr" ben-firma__create_note "$(note "$m4")" | cut -d: -f1)" "REJECTED"
expect "demoted ben: nothing written after the demotion" "$(found firma "$m4")" "0"
provision   # restore ben as writer (again rotates his key and restarts MetaMCP)
BEN=$(key ben) ANNA=$(key anna)

echo "== 8. Session binding in mcp-gate (M2)"
sb2=$(open ben "$BEN"); sa2=$(open anna "$ANNA")
expect "sessions for both users open" "$([[ -n $sb2 && -n $sa2 ]] && echo yes || echo no)" "yes"
rpc anna key "$ANNA" "$sb2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "anna's key on her endpoint + ben's session id → rejected" "$STATUS" "401"
expect "… and no ben tools or session ids in the response" "$(grep -cE 'ben-(vault|firma)__|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$tmp/b")" "0"
expect "anna's key + ben's session id + write call → rejected" \
  "$(call anna "$ANNA" "$sb2" ben-firma__create_note "$(note "$m4")" | cut -d: -f1)" "REJECTED"
rpc anna key "$BEN" "$sb2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "ben's own key + his session id on anna's endpoint → rejected" "$STATUS" "401"
rpc ben key "$BEN" "$sa2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "ben's key on his endpoint + anna's session id → rejected" "$STATUS" "401"
rpc ben none "" "$sb2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "ben's session id without any key → rejected" "$STATUS" "401"
rpc ben key "$BEN" "$sb2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "owner still uses his session (control)" "$STATUS" "200"
expect "gate routes nothing but /mcp: /metamcp/health/sessions" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/sessions")" "302|401|404"
docker compose restart mcp-gate >/dev/null
deadline=$((SECONDS + 60))
until [[ $(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q mcp-gate)") == healthy ]] || ((SECONDS > deadline)); do sleep 2; done
rpc ben key "$BEN" "$sb2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
expect "after a gate restart the old session is rejected (client must re-initialize)" "$STATUS" "401"
expect "after a gate restart a new session works" "$([[ -n $(open ben "$BEN") ]] && echo yes || echo no)" "yes"

echo
echo "RESULT: $pass passed, $fail failed, $xfailed expected failures (known open findings), $xpassed unexpectedly passing"
[[ $fail -eq 0 ]]
