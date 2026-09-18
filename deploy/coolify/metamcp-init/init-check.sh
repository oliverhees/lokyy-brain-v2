#!/bin/sh
# lokyy-init (LBV2-27, one-shot, runs before every other service): refuses operator input that could break
# or inject into Traefik rules, the Authentik blueprint, JSON or SQL (LOW-1), then prepares ownership of
# the shared state volumes: lokyy-state is written by the portal (uid 1000) and read by mcp-gate and
# MetaMCP; lokyy-provision is written by the MetaMCP watcher (uid 1001) and read by the portal (gid 1000).
set -eu
die() { echo "fatal: $*" >&2; exit 1; }
label='[a-z0-9]([a-z0-9-]*[a-z0-9])?'
printf '%s' "${BASE_DOMAIN:-}" | grep -Eqx "$label(\.$label)+" \
  || die "BASE_DOMAIN '${BASE_DOMAIN:-}' must be a lower-case domain like lokyy.example.de"
[ "$(printf '%s\n' "${BASE_DOMAIN}" | wc -l)" = 1 ] || die "BASE_DOMAIN must be one line"
[ "$(printf '%s' "${BASE_DOMAIN}" | wc -c)" -le 200 ] || die "BASE_DOMAIN too long"
printf '%s' "${ADMIN_EMAIL:-}" | grep -Eqx "[A-Za-z0-9._%+-]{1,64}@$label(\.$label)+" \
  || die "ADMIN_EMAIL '${ADMIN_EMAIL:-}' must be a plain address like ops@example.de (no quotes, spaces or upper-case domain)"
[ "$(printf '%s\n' "${ADMIN_EMAIL}" | wc -l)" = 1 ] || die "ADMIN_EMAIL must be one line"
state=${LOKYY_STATE:-/state} provision=${LOKYY_PROVISION:-/provision}
chown 1000:1000 "$state" && chmod 755 "$state"
# setgid: files the watcher writes inherit gid 1000, so the portal can read 0640 files
chown 1001:1000 "$provision" && chmod 2750 "$provision"
echo "lokyy-init: BASE_DOMAIN=${BASE_DOMAIN} ok, ADMIN_EMAIL ok, state volumes prepared"
