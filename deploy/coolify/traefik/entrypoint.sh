#!/bin/sh
# lokyy-traefik entrypoint (LBV2-27): validates BASE_DOMAIN, then starts Traefik with
# forwardedHeaders.trustedIPs = the subnet of the coolify network (MED-1): the one interface whose address
# is not in LOKYY_NET_PREFIX (all our own networks are). Vaults and other Lokyy containers can therefore
# never set X-Forwarded-For. LOKYY_TRUSTED_PROXY_CIDRS overrides the detection. Fails closed.
set -eu
die() { echo "fatal: $*" >&2; exit 1; }
label='[a-z0-9]([a-z0-9-]*[a-z0-9])?'
printf '%s' "${BASE_DOMAIN:-}" | grep -Eqx "$label(\.$label)+" \
  || die "BASE_DOMAIN '${BASE_DOMAIN:-}' must be a lower-case domain like lokyy.example.de (set it in Coolify)"
[ "$(printf '%s\n' "${BASE_DOMAIN}" | wc -l)" = 1 ] || die "BASE_DOMAIN must be one line"
prefix=${NET_PREFIX:?NET_PREFIX missing}
if [ -n "${LOKYY_TRUSTED_PROXY_CIDRS:-}" ]; then
  printf '%s' "$LOKYY_TRUSTED_PROXY_CIDRS" | grep -Eqx '[0-9./,]+' || die "LOKYY_TRUSTED_PROXY_CIDRS must be a comma list of IPv4 CIDRs"
  trusted=$LOKYY_TRUSTED_PROXY_CIDRS
else
  foreign=$(ip -o -4 addr show | awk '$3 == "inet" { print $4 }' | grep -v '^127\.' | grep -v "^$(printf '%s' "$prefix" | sed 's/\./\\./g')\." || true)
  [ "$(printf '%s\n' "$foreign" | grep -c .)" = 1 ] \
    || die "expected exactly one interface outside ${prefix}.0.0/16 (the coolify network), found: $(echo $foreign)"
  trusted=$foreign
fi
echo "lokyy-traefik: trusting X-Forwarded-* from $trusted" >&2
exec traefik "$@" "--entrypoints.web.forwardedHeaders.trustedIPs=$trusted"
