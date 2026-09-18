#!/bin/sh
# Refuses to start with a BASE_DOMAIN that would produce broken or ambiguous routes: lower-case ASCII
# labels (a-z 0-9 -, not starting or ending with "-"), at least one dot. Then runs Traefik unchanged.
set -eu
label='[a-z0-9]([a-z0-9-]*[a-z0-9])?'
if ! printf '%s' "${BASE_DOMAIN:-}" | grep -Eqx "$label(\.$label)+"; then
  echo "fatal: BASE_DOMAIN '${BASE_DOMAIN:-}' must be a lower-case domain like lokyy.example.de (set it in Coolify)" >&2
  exit 1
fi
exec traefik "$@"
