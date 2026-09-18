#!/usr/bin/env bash
# LBV2-27 — live smoke of the Coolify packages on a dev machine (never against a real server).
# Deploys package S as compose project "lokyy-pkg" behind a stand-in for coolify-proxy
# (fake-coolify.override.yml, https://*.pkg.localhost via 127.0.0.1:18280), with an env file that
# emulates Coolify's magic variables, then checks:
#   first start without manual steps (blueprint, bootstrap admin in lokyy-admins, MetaMCP init, models),
#   admin login, slot isolation (web, forged headers, networks, MCP keys), no host ports;
# then upgrades the same project to package M and checks that data, users and keys survived.
# The portal (apps/portal, LBV2-28) runs when its Dockerfile exists (e.g. in a local merge with that
# branch); otherwise it is skipped. users.json is written by this script either way.
#
# Usage: deploy/coolify/tests/smoke/smoke.sh [--down]
#   --down  remove containers, networks and volumes of lokyy-pkg at the end
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
coolify=$(cd "$here/../.." && pwd)
stack=$(cd "$coolify/../stack" && pwd)
work=${SMOKE_WORKDIR:-$(mktemp -d)}
env_file=$work/coolify.env
DOMAIN=pkg.localhost
PORT=18280
PROJECT=lokyy-pkg

pass=0 fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
expect() { if [[ "$2" =~ ^($3)$ ]]; then ok "$1 → $2"; else bad "$1 → $2 (expected $3)"; fi; }

# Coolify writes one random value per magic variable into the resource's .env; M is a superset of S.
if [[ ! -f $env_file ]]; then
  (umask 077
   { grep -oE 'SERVICE_[A-Z0-9_]+' "$coolify/compose-m.yml" | sort -u | while read -r v; do printf '%s=%s\n' "$v" "$(openssl rand -hex 32)"; done
     printf 'BASE_DOMAIN=%s\nADMIN_EMAIL=ops@example.com\nLOKYY_NET_PREFIX=10.233\n' "$DOMAIN"; } >"$env_file")
fi
envv() { sed -n "s/^$1=//p" "$env_file"; }

dc() { local pkg=$1; shift; docker compose -p "$PROJECT" --env-file "$env_file" -f "$coolify/compose-$pkg.yml" -f "$here/fake-coolify.override.yml" "$@"; }
repo=$(cd "$coolify/../.." && pwd)
# SMOKE_SKIP_PORTAL=1 builds the package without starting the portal (e.g. before authentik-gate exists)
has_portal() { [[ -f $repo/apps/portal/Dockerfile && ${SMOKE_SKIP_PORTAL:-0} != 1 ]]; }
services() { if has_portal; then dc "$1" config --services; else dc "$1" config --services | grep -vx portal; fi; }

curlk() { curl -sk --connect-to "::127.0.0.1:$PORT" "$@"; }
code() { curlk -o /dev/null -w '%{http_code}' "$@"; }
U() { printf 'https://%s.%s' "$1" "$DOMAIN"; }
api() { # api <method> <path> [json]
  curlk -X "$1" -H "Authorization: Bearer $(envv SERVICE_HEX_64_PORTALAKTOKEN)" -H 'content-type: application/json' \
    ${3:+-d "$3"} "$(U auth)/api/v3$2"
}

wait_for() { # wait_for <what> <timeout-s> <command...>
  local what=$1 deadline=$(( $(date +%s) + $2 )); shift 2
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) > deadline )) && { bad "timeout waiting for: $what"; return 1; }
    sleep 3
  done
  ok "ready: $what"
}
healthy() { dc "$1" ps --format json | jq -se '[.[] | select(.Service != "coolify-proxy" and .Service != "lokyy-traefik")] | length > 10 and all(.[]; .Health == "healthy")'; }
# blueprint <pkg>: lokyy-slots applied successfully from the file currently in the image (hash matches)
blueprint() {
  dc "$1" exec -T authentik-worker ak shell -c "
import sys
from hashlib import sha512
from authentik.blueprints.models import BlueprintInstance
h = sha512(open('/blueprints/custom/lokyy-slots.yaml', 'rb').read()).hexdigest()
sys.exit(0 if BlueprintInstance.objects.filter(name='lokyy-slots', status='successful', last_applied_hash=h).exists() else 1)"
}
# metamcp_ready <pkg>: MetaMCP's backend answers (it restarts after access changes)
metamcp_ready() { dc "$1" exec -T metamcp wget -q -O /dev/null http://127.0.0.1:12008/api/auth/get-session; }
routes() { local v; for v in "$@"; do [[ $(code "$(U "$v")/") == 302 ]] || return 1; done; }
init_done() { [[ $(docker inspect -f '{{.State.ExitCode}} {{.State.Status}}' "$(dc "$1" ps -aq "$2")") == "0 exited" ]]; }

# login <jar> <protected-url> <uid> <password>: Authentik flow executor through the forward-auth chain
login() {
  local jar=$1 url=$2 user=$3 pass=$4 final flow query exec_url resp kind to
  final=$(curlk -L -c "$jar" -b "$jar" -o /dev/null -w '%{url_effective}' "$url")
  flow=$(sed -nE 's#.*/if/flow/([^/?]+)/.*#\1#p' <<<"$final")
  query=$(sed -nE 's#^[^?]*\?(.*)$#\1#p' <<<"$final")
  [[ -n $flow ]] || { echo "no flow redirect (landed on $final)" >&2; return 2; }
  exec_url="$(U auth)/api/v3/flows/executor/$flow/?query=$(jq -rn --arg q "$query" '$q|@uri')"
  csrf() { awk '$6=="authentik_csrf"{print $7}' "$jar" | tail -1; }
  post() { curlk -L -c "$jar" -b "$jar" -H 'content-type: application/json' -H "x-authentik-csrf: $(csrf)" -H "referer: $(U auth)/" -d "$1" "$exec_url"; }
  curlk -c "$jar" -b "$jar" "$exec_url" >/dev/null
  post "$(jq -cn --arg u "$user" '{component:"ak-stage-identification",uid_field:$u}')" >/dev/null
  resp=$(post "$(jq -cn --arg p "$pass" '{component:"ak-stage-password",password:$p}')")
  for _ in 1 2 3; do
    kind=$(jq -r '.component // .type' <<<"$resp")
    case $kind in
      xak-flow-redirect | redirect)
        to=$(jq -r '.to' <<<"$resp")
        curlk -L -c "$jar" -b "$jar" -o /dev/null "$([[ $to == http* ]] && echo "$to" || echo "$(U auth)$to")"; return 0 ;;
      ak-stage-consent) resp=$(post "$(jq -c '{component:"ak-stage-consent",token:.token}' <<<"$resp")") ;;
      *) echo "unexpected stage: $(jq -c '{component,type,response_errors}' <<<"$resp")" >&2; return 4 ;;
    esac
  done
}
# access <jar> <url> [curl args] → DATA (backend answered JSON), DENIED, LOGIN or OTHER:<code>
access() {
  local jar=$1 url=$2 body out status final; shift 2
  body=$(mktemp)
  out=$(curlk -L -b "$jar" -c "$jar" -o "$body" -w '%{http_code} %{url_effective}' "$@" "$url")
  status=${out%% *} final=${out#* }
  if [[ $status == 200 && ${final%%\?*} == "${url%%\?*}" ]] && jq -e . "$body" >/dev/null 2>&1; then echo DATA
  elif grep -q "Permission denied" "$body"; then echo DENIED
  elif [[ $final == *"/if/flow/default-authentication-flow/"* ]]; then echo LOGIN
  else echo "OTHER:$status"; fi
  rm -f "$body"
}

create_user() { # create_user <username> <password> <group>...
  local user=$1 pass=$2 groups=() g pk
  shift 2
  for g in "$@"; do groups+=("$(api GET "/core/groups/?name=$g" | jq -r '.results[0].pk')"); done
  pk=$(api GET "/core/users/?username=$user" | jq -r '.results[0].pk // empty')
  if [[ -z $pk ]]; then
    pk=$(api POST /core/users/ "$(jq -cn --arg u "$user" --args '{username:$u,name:$u,email:($u+"@example.com"),is_active:true,groups:$ARGS.positional}' "${groups[@]}")" | jq -r .pk)
  fi
  api POST "/core/users/$pk/set_password/" "$(jq -cn --arg p "$pass" '{password:$p}')" >/dev/null
  [[ $pk =~ ^[0-9]+$ ]]
}

# from <vault-service> <url> → OPEN or blocked (plain TCP/HTTP reachability from inside a vault)
from() { dc "$1" exec -T "$2" node -e "fetch('$3',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('OPEN'),()=>console.log('blocked'))" 2>/dev/null; }

# pfetch <pkg> <service> <method> <url> → HTTP status or "blocked" (node fetch inside that container)
pfetch() {
  dc "$1" exec -T "$2" node -e "fetch('$4',{method:'$3',signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status),()=>console.log('blocked'))" 2>/dev/null
}
# every proxy provider has the 5 managed scope mappings (read via ak shell: the portal account may not list providers)
scope_mappings() {
  dc "$1" exec -T authentik-worker ak shell -c "
from authentik.providers.proxy.models import ProxyProvider
bad = [p.name for p in ProxyProvider.objects.all() if p.property_mappings.count() != 5]
print('all' if ProxyProvider.objects.exists() and not bad else ','.join(bad) or 'none')" 2>/dev/null | tail -1
}
mcp_ok() { [[ $(mcp_init "$1" "$2") == 200 ]]; }
mcp_init() { # mcp_init <key> <user-endpoint> → HTTP status of an MCP initialize through mcp-gate
  curlk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    "$(U mcp)/metamcp/$2/mcp"
}
# provision <users-array-json> [rotate-json]: what the portal does (direct provisioning, LBV2-28), using the
# shared provisioner deploy/stack/metamcp/provision.mjs inside the metamcp container; restarts MetaMCP when
# access changed, like the portal and provision.sh do. Vault tokens come from the Coolify env, never argv.
provision_run() {
  local users=$1 rotate=${2:-[]} args=()
  for v in $(grep -oE '^SERVICE_HEX_64_MCP(V[0-9]+|FIRMA|READONLYFIRMA)=' "$env_file" | sed 's/^SERVICE_HEX_64_MCP//; s/=$//'); do
    local name=MCP_TOKEN_$v; [[ $v == READONLYFIRMA ]] && name=MCP_READONLY_TOKEN_FIRMA
    export "$name=$(envv "SERVICE_HEX_64_MCP$v")"; args+=(-e "$name")
  done
  export LOKYY_USERS; LOKYY_USERS=$(jq -cn --argjson u "$users" '{companyVault:"firma",users:$u}')
  export LOKYY_ROTATE=$rotate LOKYY_PUBLIC_BASE; LOKYY_PUBLIC_BASE=$(U mcp)
  wait_for "MetaMCP ready before provisioning" 300 metamcp_ready "$PKG" >/dev/null
  dc "$PKG" exec -T -w /app/apps/backend -e LOKYY_USERS -e LOKYY_ROTATE -e LOKYY_PUBLIC_BASE "${args[@]}" metamcp \
    node --input-type=module - <"$stack/metamcp/provision.mjs" >"$work/clients.json" 2>"$work/provision.log"
  if [[ $(jq -r .restartMetamcp "$work/clients.json") == true ]]; then
    dc "$PKG" restart metamcp >/dev/null
    sleep 5
    wait_for "MetaMCP ready after restart" 300 metamcp_ready "$PKG" >/dev/null
  fi
}
provision() {
  PKG=$1 provision_run '[{"username":"alice","role":"reader","vault":"v01","allowVaultNameMismatch":true},
                         {"username":"bob","role":"writer","vault":"v02","allowVaultNameMismatch":true}]'
  [[ $(jq -r '.status' "$work/clients.json") == ok ]]
}
key() { jq -r --arg u "$1" '.users[] | select(.username == $u) | .apiKey' "$work/clients.json"; }

jars=$work/jars; mkdir -p "$jars"
admin_pass=$(envv SERVICE_PASSWORD_ADMIN)

isolation_checks() { # isolation_checks <pkg> <last-slot>
  local pkg=$1 last=$2 j
  for j in alice bob walt rita ulla admin; do rm -f "$jars/$j"; done
  echo "== [$pkg] anonymous access is redirected to the login"
  for v in v01 v02 "$last" firma mcp app; do
    expect "anon → $v" "$(curlk -o /dev/null -w '%{http_code} %{redirect_url}' "$(U "$v")/api/config" | sed -E 's#^(302) https://auth\..*#\1 auth#')" "302 auth"
  done

  echo "== [$pkg] bootstrap admin (ADMIN_EMAIL + generated password)"
  login "$jars/admin" "$(U mcp)/" "ops@example.com" "$admin_pass" && ok "admin login with ADMIN_EMAIL" || bad "admin login with ADMIN_EMAIL"
  expect "admin → MetaMCP admin UI" "$(access "$jars/admin" "$(U mcp)/health")" "DATA"
  expect "admin in lokyy-admins" "$(api GET '/core/users/?username=akadmin' | jq -r '[.results[0].groups_obj[].name] | index("lokyy-admins") != null')" "true"
  expect "admin → personal vault v01 (no slot group)" "$(access "$jars/admin" "$(U v01)/api/config")" "DENIED"

  echo "== [$pkg] slot isolation (web)"
  login "$jars/alice" "$(U v01)/" alice "$(cat "$work/pass-alice")" || bad "alice login"
  login "$jars/bob" "$(U v02)/" bob "$(cat "$work/pass-bob")" || bad "bob login"
  login "$jars/walt" "$(U firma)/" walt "$(cat "$work/pass-walt")" || bad "walt login"
  login "$jars/rita" "$(U v01)/" rita "$(cat "$work/pass-rita")" 2>/dev/null || true
  login "$jars/ulla" "$(U app)/" ulla "$(cat "$work/pass-ulla")" 2>/dev/null || true
  expect "alice → v01 (own slot)" "$(access "$jars/alice" "$(U v01)/api/config")" "DATA"
  expect "bob → v02 (own slot)" "$(access "$jars/bob" "$(U v02)/api/config")" "DATA"
  expect "alice → v02" "$(access "$jars/alice" "$(U v02)/api/config")" "DENIED"
  expect "bob → v01" "$(access "$jars/bob" "$(U v01)/api/config")" "DENIED"
  expect "alice → $last" "$(access "$jars/alice" "$(U "$last")/api/config")" "DENIED"
  expect "walt (firma-write) → firma" "$(access "$jars/walt" "$(U firma)/api/config")" "DATA"
  expect "rita (firma-read) → firma web" "$(access "$jars/rita" "$(U firma)/api/config")" "DENIED"
  expect "alice → MetaMCP admin" "$(access "$jars/alice" "$(U mcp)/health")" "DENIED"
  expect "alice → portal (app.)" "$(access "$jars/alice" "$(U app)/")" "DENIED"

  echo "== [$pkg] forged headers"
  expect "alice → v02 with X-authentik-username: bob" "$(access "$jars/alice" "$(U v02)/api/config" -H 'X-authentik-username: bob')" "DENIED"
  expect "alice → v02 with X_authentik_username: bob" "$(access "$jars/alice" "$(U v02)/api/config" -H 'X_authentik_username: bob')" "DENIED"
  expect "alice → v02 with X-Forwarded-Host: v01 (pinned per router)" "$(access "$jars/alice" "$(U v02)/api/config" -H "X-Forwarded-Host: v01.$DOMAIN")" "DENIED"
  expect "anon → v01 with X-Forwarded-Host: v02: redirect names v01" \
    "$(curlk -o /dev/null -w '%{redirect_url}' -H "X-Forwarded-Host: v02.$DOMAIN" "$(U v01)/" | grep -q 'redirect_uri=https%3A%2F%2Fv01\.' && echo v01 || echo other)" "v01"
  expect "anon → v02 with v02's real proxy secret" "$(code -H "X-Vault-Proxy-Secret: $(envv SERVICE_HEX_64_PROXYV02)" "$(U v02)/api/config")" "302"

  echo "== [$pkg] networks"
  for target in "http://vault-v02:4321" "http://vault-$last:4321" "http://authentik-server:9000" "http://metamcp:12008" "http://metamcp-db:5432" "http://vault-connector:4322" "http://10.233.0.62:4322"; do
    expect "vault-v01 → $target" "$(from "$pkg" vault-v01 "$target")" "blocked"
  done
  expect "vault-$last → http://vault-v01:4321" "$(from "$pkg" "vault-$last" http://vault-v01:4321)" "blocked"
  local nets
  nets=$(docker inspect "$(dc "$pkg" ps -q vault-v01)" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort | xargs)
  expect "vault-v01 networks" "$nets" "${PROJECT}_egress ${PROJECT}_mcp-v01 ${PROJECT}_web-v01"
  expect "published host ports (only the stand-in proxy)" \
    "$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Ports}}' | grep -c -- '->' )" "1"

  if has_portal && [[ -n $(dc "$pkg" ps -q portal 2>/dev/null) ]]; then
    echo "== [$pkg] portal (app.) and its vault config entrypoint"
    expect "admin → portal /api/session" "$(access "$jars/admin" "$(U app)/api/session")" "DATA"
    expect "ulla (lokyy-users) → portal /api/session" "$(access "$jars/ulla" "$(U app)/api/session")" "DATA"
    local P=10.233.0.93:8090
    expect "portal → GET /v01/api/config" "$(pfetch "$pkg" portal GET "http://$P/v01/api/config")" "200"
    expect "portal → GET /firma/api/config" "$(pfetch "$pkg" portal GET "http://$P/firma/api/config")" "200"
    expect "portal → DELETE /v01/api/config" "$(pfetch "$pkg" portal DELETE "http://$P/v01/api/config")" "404|405"
    expect "portal → GET /v01/api/wiki (not config)" "$(pfetch "$pkg" portal GET "http://$P/v01/api/wiki")" "404"
    expect "portal → GET /v01/api/config/../wiki" "$(pfetch "$pkg" portal GET "http://$P/v01/api/config/..%2Fwiki")" "404|400"
    expect "vault-v01 → portal-admin entrypoint" "$(pfetch "$pkg" vault-v01 GET "http://$P/v02/api/config")" "blocked"
    expect "metamcp → portal-admin entrypoint" "$(from "$pkg" metamcp "http://$P/v01/api/config" 2>/dev/null || echo blocked)" "blocked"
    expect "public host with portal-admin path" "$(code "$(U app)/v01/api/config")" "302"
  fi

  echo "== [$pkg] MCP keys per user (through mcp-gate)"
  expect "alice key → alice endpoint" "$(mcp_init "$(key alice)" alice)" "200"
  expect "alice key → bob endpoint" "$(mcp_init "$(key alice)" bob)" "401"
  expect "no key → alice endpoint" "$(mcp_init '' alice)" "401"
}

# ------------------------------------------------------------------- package S
echo "== deploy package S (project $PROJECT, env $env_file)"
dc s up -d --build $(services s) >"$work/up-s.log" 2>&1 || { tail -20 "$work/up-s.log"; bad "compose up S"; }
wait_for "S: all services healthy" 600 healthy s
wait_for "S: blueprint lokyy-slots applied (automatic)" 300 blueprint s
wait_for "S: metamcp-init finished (automatic)" 120 init_done s metamcp-init
wait_for "S: model-prefetch verified (automatic)" 60 init_done s model-prefetch
wait_for "S: vault routes behind forward-auth" 120 routes v01 v15 firma

for u in alice bob walt rita ulla; do [[ -f $work/pass-$u ]] || (umask 077; openssl rand -hex 16 >"$work/pass-$u"); done
create_user alice "$(cat "$work/pass-alice")" vault-v01 && create_user bob "$(cat "$work/pass-bob")" vault-v02 \
  && create_user walt "$(cat "$work/pass-walt")" vault-firma-write && create_user rita "$(cat "$work/pass-rita")" vault-firma-read \
  && create_user ulla "$(cat "$work/pass-ulla")" vault-v03 lokyy-users \
  && ok "users created via Authentik API (bootstrap token)" || bad "user creation via Authentik API"
provision s && ok "MCP provisioning (provision.mjs, as the portal does)" || { cat "$work/provision.log"; bad "provisioning"; }
isolation_checks s v15

echo "== [s] provisioning: rotation, removal, a failing entry does not block others"
old_alice=$(key alice) old_bob=$(key bob)
PKG=s provision_run '[{"username":"alice","role":"reader","vault":"v01","allowVaultNameMismatch":true},
                      {"username":"zed","role":"writer","vault":"v01","allowVaultNameMismatch":true},
                      {"username":"carl","role":"writer","vault":"v04","allowVaultNameMismatch":true}]' '["alice"]'
expect "run status with one invalid entry" "$(jq -r .status "$work/clients.json")" "failed"
expect "per-user status" "$(jq -r '[.users[] | "\(.username)=\(.status)"] | sort | join(",")' "$work/clients.json")" "alice=ok,carl=ok,zed=failed"
expect "no key for the failed entry" "$(jq -r '.users[] | select(.username=="zed") | .apiKey // "none"' "$work/clients.json")" "none"
expect "bob removed" "$(jq -r '.removed | join(",")' "$work/clients.json")" "bob"
expect "alice key rotated" "$([[ $(key alice) != "$old_alice" && -n $(key alice) ]] && echo new || echo same)" "new"
wait_for "MCP endpoint answers after the MetaMCP restart" 240 mcp_ok "$(key alice)" alice
expect "old alice key" "$(mcp_init "$old_alice" alice)" "401"
expect "removed bob's key" "$(mcp_init "$old_bob" bob)" "401"
expect "carl key" "$(mcp_init "$(key carl)" carl)" "200"
PKG=s provision_run '[{"username":"alice","role":"reader","vault":"v01","allowVaultNameMismatch":true},
                      {"username":"bob","role":"writer","vault":"v02","allowVaultNameMismatch":true}]'
[[ $(jq -r .status "$work/clients.json") == ok ]] && ok "bob back, carl removed" || bad "second provisioning run"
wait_for "MCP endpoint answers after the MetaMCP restart" 240 mcp_ok "$(key bob)" bob
expect "alice key unchanged without rotation" "$(mcp_init "$(key alice)" alice)" "200"

echo "== [s] Authentik providers carry the proxy scope mappings (non-empty identity on a fresh stack)"
PKG=s
expect "proxy providers with 5 property mappings / all" \
  "$(scope_mappings "$PKG")" "all"

# data that must survive the upgrade
dc s exec -T vault-v01 sh -c 'echo lbv2-27 > /data/upgrade-marker' && ok "marker written to vault-v01 volume" || bad "marker write"
alice_key=$(key alice)

# The portal reconciles MetaMCP from its own state; this smoke provisions its test users directly, so the
# portal is stopped before the upgrade (its wiring was checked above; M only adds slots).
if has_portal; then dc s stop portal >/dev/null 2>&1 && dc s rm -f portal >/dev/null 2>&1; fi

# ------------------------------------------------------------------- upgrade to M
echo "== upgrade the same project to package M"
dc m up -d --build $(services m | grep -vx portal) >"$work/up-m.log" 2>&1 || { tail -20 "$work/up-m.log"; bad "compose up M"; }
wait_for "M: all services healthy" 600 healthy m
wait_for "M: blueprint lokyy-slots re-applied (hash of the M file)" 1200 blueprint m
wait_for "M: routes for new slots (worker re-applies the blueprint)" 900 routes v01 v16 v30 firma
expect "vault-v01 data survived S → M" "$(dc m exec -T vault-v01 cat /data/upgrade-marker)" "lbv2-27"
expect "M: 31 vault services running" "$(dc m ps --format '{{.Service}}' | grep -cE '^vault-(v[0-9]+|firma)$')" "31"
PKG=m; expect "M: proxy providers with 5 property mappings" \
  "$(scope_mappings "$PKG")" "all"
expect "alice's MCP key unchanged after upgrade" "$(key alice)" "$alice_key"
isolation_checks m v30

echo
echo "passed $pass, failed $fail   (work dir with env + logs: $work)"
if [[ ${1:-} == --down ]]; then dc m down -v --remove-orphans >/dev/null 2>&1; echo "stack $PROJECT removed"; fi
((fail == 0))
