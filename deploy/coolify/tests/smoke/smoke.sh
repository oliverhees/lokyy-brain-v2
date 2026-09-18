#!/usr/bin/env bash
# LBV2-27 — live smoke of the Coolify packages on a dev machine (never against a real server).
# Deploys package S as compose project "lokyy-pkg" behind a stand-in for coolify-proxy
# (fake-coolify.override.yml, https://*.pkg.localhost via 127.0.0.1:18280), with an env file that
# emulates Coolify's magic variables, then checks:
#   first start without manual steps (blueprint, bootstrap admin in lokyy-admins, MetaMCP init, models),
#   admin login, slot isolation (web, forged headers, networks, MCP keys), no host ports;
# then upgrades the same project to package M and checks that data, users and keys survived.
# The portal (apps/portal, LBV2-28) is not started; its users.json is written by this script.
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
services() { dc "$1" config --services | grep -vx portal; }

curlk() { curl -sk --connect-to "::127.0.0.1:$PORT" "$@"; }
code() { curlk -o /dev/null -w '%{http_code}' "$@"; }
U() { printf 'https://%s.%s' "$1" "$DOMAIN"; }
api() { # api <method> <path> [json]
  curlk -X "$1" -H "Authorization: Bearer $(envv SERVICE_HEX_64_AUTHENTIKAPITOKEN)" -H 'content-type: application/json' \
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
blueprint() {
  dc "$1" exec -T authentik-worker ak shell -c "
from authentik.blueprints.models import BlueprintInstance
import sys; sys.exit(0 if BlueprintInstance.objects.filter(name='lokyy-slots', status='successful').exists() else 1)"
}
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

mcp_init() { # mcp_init <key> <user-endpoint> → HTTP status of an MCP initialize through mcp-gate
  curlk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    "$(U mcp)/metamcp/$2/mcp"
}
provision() { # stands in for the portal: users.json into lokyy-state, provisioning inside metamcp
  local pkg=$1
  jq -n '{companyVault:"firma",users:[
      {username:"alice",role:"reader",vault:"v01",allowVaultNameMismatch:true},
      {username:"bob",role:"writer",vault:"v02",allowVaultNameMismatch:true}]}' >"$work/users.json"
  docker run --rm -i -v "${PROJECT}_lokyy-state:/state" alpine:3.22 sh -c 'cat >/state/users.json' <"$work/users.json"
  dc "$pkg" exec -T -w /app/apps/backend -e LOKYY_USERS="$(jq -c . "$work/users.json")" -e 'LOKYY_ROTATE=[]' \
    -e LOKYY_PUBLIC_BASE="$(U mcp)" metamcp node --input-type=module - <"$stack/metamcp/provision.mjs" >"$work/clients.json" 2>"$work/provision.log"
}
key() { jq -r --arg u "$1" '.users[] | select(.username == $u) | .apiKey' "$work/clients.json"; }

jars=$work/jars; mkdir -p "$jars"
admin_pass=$(envv SERVICE_PASSWORD_ADMIN)

isolation_checks() { # isolation_checks <pkg> <last-slot>
  local pkg=$1 last=$2 j
  for j in alice bob walt rita admin; do rm -f "$jars/$j"; done
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

for u in alice bob walt rita; do [[ -f $work/pass-$u ]] || (umask 077; openssl rand -hex 16 >"$work/pass-$u"); done
create_user alice "$(cat "$work/pass-alice")" vault-v01 && create_user bob "$(cat "$work/pass-bob")" vault-v02 \
  && create_user walt "$(cat "$work/pass-walt")" vault-firma-write && create_user rita "$(cat "$work/pass-rita")" vault-firma-read \
  && ok "users created via Authentik API (bootstrap token)" || bad "user creation via Authentik API"
provision s && ok "MCP provisioning inside metamcp (tokens from its env)" || { cat "$work/provision.log"; bad "provisioning"; }
dc s up -d --force-recreate --no-deps mcp-gate >/dev/null 2>&1
wait_for "S: mcp-gate healthy after users.json" 60 healthy s
isolation_checks s v15

# data that must survive the upgrade
dc s exec -T vault-v01 sh -c 'echo lbv2-27 > /data/upgrade-marker' && ok "marker written to vault-v01 volume" || bad "marker write"
alice_key=$(key alice)

# ------------------------------------------------------------------- upgrade to M
echo "== upgrade the same project to package M"
dc m up -d --build $(services m) >"$work/up-m.log" 2>&1 || { tail -20 "$work/up-m.log"; bad "compose up M"; }
wait_for "M: all services healthy" 600 healthy m
wait_for "M: blueprint lokyy-slots re-applied" 300 blueprint m
wait_for "M: routes for new slots (worker re-applies the blueprint)" 900 routes v01 v16 v30 firma
expect "vault-v01 data survived S → M" "$(dc m exec -T vault-v01 cat /data/upgrade-marker)" "lbv2-27"
expect "M: 31 vault services running" "$(dc m ps --format '{{.Service}}' | grep -cE '^vault-(v[0-9]+|firma)$')" "31"
expect "alice's MCP key unchanged after upgrade" "$(key alice)" "$alice_key"
isolation_checks m v30

echo
echo "passed $pass, failed $fail   (work dir with env + logs: $work)"
if [[ ${1:-} == --down ]]; then dc m down -v --remove-orphans >/dev/null 2>&1; echo "stack $PROJECT removed"; fi
((fail == 0))
