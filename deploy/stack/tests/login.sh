#!/usr/bin/env bash
# Logs in to Authentik through the forward-auth redirect chain of a protected host,
# using the flow executor API. Leaves the session in the given cookie jar.
# Usage: login.sh <cookie-jar> <protected-url> <username> <password>
set -euo pipefail
jar=$1 url=$2 user=$3 pass=$4
base=http://auth.localhost:18080

# 1. Follow redirects from the protected URL to the Authentik flow page.
final=$(curl -s -L -c "$jar" -b "$jar" -o /dev/null -w '%{url_effective}' "$url")
flow=$(sed -nE 's#.*/if/flow/([^/?]+)/.*#\1#p' <<<"$final")
query=$(sed -nE 's#^[^?]*\?(.*)$#\1#p' <<<"$final")
[[ -n "$flow" ]] || { echo "no flow redirect (landed on $final)" >&2; exit 2; }
exec_url="$base/api/v3/flows/executor/$flow/?query=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$query")"

csrf() { awk '$6=="authentik_csrf"{print $7}' "$jar" | tail -1; }
post() { curl -s -L -c "$jar" -b "$jar" -H 'content-type: application/json' -H "x-authentik-csrf: $(csrf)" -H "referer: $base/" -d "$1" "$exec_url"; }

curl -s -c "$jar" -b "$jar" "$exec_url" >/dev/null
post "{\"component\":\"ak-stage-identification\",\"uid_field\":\"$user\"}" >/dev/null
resp=$(post "{\"component\":\"ak-stage-password\",\"password\":\"$pass\"}")
# Consent / redirect stages
for _ in 1 2 3; do
  kind=$(jq -r '.component // .type' <<<"$resp")
  case "$kind" in
    xak-flow-redirect|redirect) to=$(jq -r '.to' <<<"$resp"); curl -s -L -c "$jar" -b "$jar" -o /dev/null "$( [[ $to == http* ]] && echo "$to" || echo "$base$to")"; exit 0 ;;
    ak-stage-consent) resp=$(post '{"component":"ak-stage-consent","token":'"$(jq '.token' <<<"$resp")"'}') ;;
    ak-stage-access-denied) echo "access denied" >&2; exit 3 ;;
    *) echo "unexpected stage: $(jq -c '{component,type,response_errors}' <<<"$resp")" >&2; exit 4 ;;
  esac
done
