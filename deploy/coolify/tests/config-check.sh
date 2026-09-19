#!/usr/bin/env bash
# LBV2-27 — static checks of the Coolify packages (no containers started).
# 1. Generator unit tests (includes "generated files up to date").
# 2. For each package: render with `docker compose config` and a synthetic .env that emulates what Coolify
#    writes in Raw mode (every SERVICE_* magic variable with a random value, plus BASE_DOMAIN/ADMIN_EMAIL),
#    then assert the security invariants on the rendered model.
# Usage: deploy/coolify/tests/config-check.sh
set -euo pipefail
dir=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

node --test "$dir"/tests/*.test.ts >"$tmp/unit.log" 2>&1 && echo "ok   unit tests (generator, entrypoints, watcher)" || { cat "$tmp/unit.log"; echo "FAIL generator unit tests"; fail=1; }
node --test "$dir/../stack/tests/blueprint-check.test.ts" >"$tmp/bp.log" 2>&1 && echo "ok   blueprint checker tests (YAML parse, fixtures, shipped blueprints)" || { cat "$tmp/bp.log"; echo "FAIL blueprint checker tests"; fail=1; }
check "blueprint-check passes every shipped blueprint" '"$dir/../stack/tests/blueprint-check.sh" "$dir"/authentik/blueprints/*.yaml "$dir"/../stack/authentik/blueprints/*.yaml >/dev/null 2>&1'
check "generator --check reports no stale file" 'node "$dir/generate.ts" --check'

# Like Coolify: SERVICE_PASSWORD_64_* = 64 alphanumeric characters, SERVICE_HEX_64_* = 64 hex digits
magic_value() { case $1 in SERVICE_PASSWORD_64_*) openssl rand -base64 192 | tr -dc 'A-Za-z0-9' | head -c 64 ;; SERVICE_PASSWORD_*) openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c 32 ;; *) openssl rand -hex 32 ;; esac; }
# Emulates Coolify: one random value per magic variable referenced in the file.
magic_env() {
  grep -oE 'SERVICE_[A-Z0-9_]+' "$1" | sort -u | while read -r v; do printf '%s=%s\n' "$v" "$(magic_value "$v")"; done
  printf 'BASE_DOMAIN=beta.example.test\nADMIN_EMAIL=ops@example.test\nCOOLIFY_RESOURCE_UUID=rsc0test\n'
}

for pkg in s m; do
  f=$dir/compose-$pkg.yml
  magic_env "$f" >"$tmp/$pkg.env"
  check "$pkg: docker compose config -q with Coolify-like env" 'docker compose --env-file "$tmp/$pkg.env" -f "$f" config -q'
  check "$pkg: rendering fails without BASE_DOMAIN" '! docker compose --env-file <(grep -v ^BASE_DOMAIN= "$tmp/$pkg.env") -f "$f" config -q 2>/dev/null'
  check "$pkg: rendering fails without ADMIN_EMAIL" '! docker compose --env-file <(grep -v ^ADMIN_EMAIL= "$tmp/$pkg.env") -f "$f" config -q 2>/dev/null'
  # LOW-B: without an instance id the coolify-proxy router names of two instances on one host would collide
  check "$pkg: rendering fails without COOLIFY_RESOURCE_UUID" '! env -u COOLIFY_RESOURCE_UUID docker compose --env-file <(grep -v ^COOLIFY_RESOURCE_UUID= "$tmp/$pkg.env") -f "$f" config -q 2>/dev/null'
  check "$pkg: rendering fails with an empty COOLIFY_RESOURCE_UUID" '! env -u COOLIFY_RESOURCE_UUID docker compose --env-file <(sed "s/^COOLIFY_RESOURCE_UUID=.*/COOLIFY_RESOURCE_UUID=/" "$tmp/$pkg.env") -f "$f" config -q 2>/dev/null'
  docker compose --env-file "$tmp/$pkg.env" -f "$f" config --format json >"$tmp/$pkg.json"
  q() { jq -r "$1" "$tmp/$pkg.json"; }

  check "$pkg: no service publishes a port" '[[ $(q "[.services[] | (.ports // []) | length] | add") == 0 ]]'
  check "$pkg: only lokyy-traefik joins coolify" '[[ $(q "[.services | to_entries[] | select(.value.networks | has(\"coolify\")) | .key] | join(\",\")") == lokyy-traefik ]]'
  check "$pkg: only lokyy-traefik carries traefik.* labels" '[[ $(q "[.services | to_entries[] | select((.value.labels // {}) | keys | any(startswith(\"traefik.\"))) | .key] | join(\",\")") == lokyy-traefik ]]'
  check "$pkg: no Docker socket mounted anywhere" '[[ $(q "[.services[] | (.volumes // [])[] | select(.source == \"/var/run/docker.sock\")] | length") == 0 ]]'
  check "$pkg: no bind mounts" '[[ $(q "[.services[] | (.volumes // [])[] | select(.type == \"bind\")] | length") == 0 ]]'
  check "$pkg: no empty secret after interpolation" '[[ $(q "[.services[] | (.environment // {}) | to_entries[] | select((.key | test(\"PASS|SECRET|TOKEN\")) and ((.value // \"\") | length) < 32)] | length") == 0 ]]'
  check "$pkg: every subnet rendered under 10.231" '[[ $(q "[.networks[] | (.ipam.config // [])[] | .subnet | select(startswith(\"10.231.\") | not)] | length") == 0 ]]'

  # LBV2-28 portal wiring: portal only on edge + portal; admin entrypoint bound to Traefik's portal address
  check "$pkg: portal networks edge,metamcp-internal,portal,portal-gate (never a vault network)" '[[ $(q ".services.portal.networks | keys | join(\",\")") == edge,metamcp-internal,portal,portal-gate ]]'
  check "$pkg: authentik-gate only on portal-gate + authentik-api" '[[ $(q ".services[\"authentik-gate\"].networks | keys | join(\",\")") == authentik-api,portal-gate ]]'
  check "$pkg: portal-gate members authentik-gate,portal" '[[ $(q "[.services | to_entries[] | select(.value.networks | has(\"portal-gate\")) | .key] | sort | join(\",\")") == authentik-gate,portal ]]'
  check "$pkg: authentik-api members authentik-gate,authentik-server" '[[ $(q "[.services | to_entries[] | select(.value.networks | has(\"authentik-api\")) | .key] | sort | join(\",\")") == authentik-gate,authentik-server ]]'
  check "$pkg: service-account token only in Authentik and authentik-gate" '[[ $(q "[.services | to_entries[] | select(.value.environment | tostring | contains(\"$(grep ^SERVICE_HEX_64_PORTALAKTOKEN= "$tmp/$pkg.env" | cut -d= -f2)\")) | .key] | sort | join(\",\")") == authentik-gate,authentik-server,authentik-worker ]]'
  check "$pkg: port gate (no hard-coded host port in deploy/)" '"$dir/../stack/tests/port-gate.sh" >/dev/null'
  check "$pkg: portal network members lokyy-traefik,portal" '[[ $(q "[.services | to_entries[] | select(.value.networks | has(\"portal\")) | .key] | sort | join(\",\")") == lokyy-traefik,portal ]]'
  check "$pkg: portal-admin entrypoint on 10.231.0.93 only" 'q ".services[\"lokyy-traefik\"].command[]" | grep -qx -- "--entrypoints.portal-admin.address=10.231.0.93:8090"'
  check "$pkg: portal has fixed address 10.231.0.94 (ipAllowList)" '[[ $(q ".services.portal.networks.portal.ipv4_address") == 10.231.0.94 && $(q ".services[\"lokyy-traefik\"].environment.PORTAL_IP") == 10.231.0.94 ]]'
  check "$pkg: portal-admin routes only via portal-only allowlist" '[[ $(grep -c "entryPoints: \[\"portal-admin\"\]" "$dir/traefik/dynamic-$pkg.yml") == $(grep -c "middlewares: \[\"portal-only\"" "$dir/traefik/dynamic-$pkg.yml") ]]'
  vaults=$(q '.services | keys[] | select(startswith("vault-") and . != "vault-connector") | ltrimstr("vault-")')
  n=0
  for v in $vaults; do
    n=$((n + 1))
    [[ $(q ".services[\"vault-$v\"].networks | keys | join(\",\")") == "egress,embed-$v,mcp-$v,web-$v" ]] || { echo "FAIL $pkg: vault-$v networks"; fail=1; }
    [[ $(q "[.services | to_entries[] | select(.value.networks | has(\"web-$v\")) | .key] | sort | join(\",\")") == "lokyy-traefik,vault-$v" ]] || { echo "FAIL $pkg: web-$v members"; fail=1; }
    [[ $(q "[.services | to_entries[] | select(.value.networks | has(\"mcp-$v\")) | .key] | sort | join(\",\")") == "vault-connector,vault-$v" ]] || { echo "FAIL $pkg: mcp-$v members"; fail=1; }
    [[ $(q "[.services | to_entries[] | select(.value.networks | has(\"embed-$v\")) | .key] | sort | join(\",\")") == "embed,vault-$v" ]] || { echo "FAIL $pkg: embed-$v members"; fail=1; }
    [[ $(q ".networks[\"web-$v\"].internal and .networks[\"mcp-$v\"].internal and .networks[\"embed-$v\"].internal") == true ]] || { echo "FAIL $pkg: $v networks not internal"; fail=1; }
    host="traefik.http.routers.lokyy-rsc0test-$v.rule"
    [[ $(q ".services[\"lokyy-traefik\"].labels[\"$host\"]") == "Host(\`$v.beta.example.test\`)" ]] || { echo "FAIL $pkg: coolify-proxy router for $v"; fail=1; }
  done
  expected=$([[ $pkg == s ]] && echo 16 || echo 31)
  check "$pkg: $expected vaults, each only on its own networks, routed by coolify-proxy" '[[ $n == "$expected" ]]'
  check "$pkg: egress has inter-container traffic off" '[[ $(q ".networks.egress.driver_opts[\"com.docker.network.bridge.enable_icc\"]") == false ]]'
  check "$pkg: metamcp not on any vault network" '! q ".services.metamcp.networks | keys[]" | grep -qE "^(web|mcp)-(v[0-9]+|firma)$"'
  check "$pkg: vault tokens distinct" '[[ $(q "[.services | to_entries[] | select(.key | test(\"^vault-(v[0-9]+|firma)$\")) | .value.environment.MCP_HTTP_TOKEN] | unique | length") == "$expected" ]]'
done
# Embed variant (LBV2-26, generator option; not committed as a file until LBV2-26 is merged)
node --input-type=module -e "import { renderCompose } from '$dir/generate.ts'; process.stdout.write(renderCompose('m', { embed: true }))" >"$dir/.compose-embed-check.yml" 2>/dev/null
magic_env "$dir/.compose-embed-check.yml" >"$tmp/embed.env"
check "m+embed: docker compose config -q" 'docker compose --env-file "$tmp/embed.env" -f "$dir/.compose-embed-check.yml" config -q'
docker compose --env-file "$tmp/embed.env" -f "$dir/.compose-embed-check.yml" config --format json >"$tmp/embed.json"
rm -f "$dir/.compose-embed-check.yml"
check "m+embed: embed only on the 31 embed-* networks" '[[ $(jq -r ".services.embed.networks | keys | map(select(startswith(\"embed-\"))) | length" "$tmp/embed.json") == 31 && $(jq -r ".services.embed.networks | length" "$tmp/embed.json") == 31 ]]'
check "m+embed: every embed token distinct" '[[ $(jq -r "[.services.embed.environment | to_entries[] | select(.key | startswith(\"EMBED_TOKEN_\")) | .value] | unique | length" "$tmp/embed.json") == 31 ]]'
exit $fail
