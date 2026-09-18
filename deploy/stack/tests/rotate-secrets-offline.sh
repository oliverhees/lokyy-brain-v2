#!/usr/bin/env bash
# LBV2-26: rotate-secrets.sh rotates the plain EMBED_TOKEN_<VAULT> values and re-derives their
# EMBED_TOKEN_SHA256_<VAULT> hashes; other lines stay. Runs on a temporary copy with docker,
# wait-ready and provisioning stubbed out (no stack needed): tests/rotate-secrets-offline.sh
set -uo pipefail
cd "$(dirname "$0")/.."
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/tests" "$t/metamcp" "$t/bin"
cp rotate-secrets.sh embed-tokens.sh "$t/"
for f in tests/wait-ready.sh metamcp/provision.sh bin/docker; do printf '#!/bin/sh\nexit 0\n' >"$t/$f"; chmod +x "$t/$f"; done
printf 'EMBED_TOKEN_ANNA=old-anna\nEMBED_TOKEN_SHA256_ANNA=%s\nEMBED_TOKEN_BEN=old-ben\nMCP_TOKEN_ANNA=old-mcp\nOTHER=keep\n' "$(printf old-anna | sha256sum | cut -d' ' -f1)" >"$t/.env"
PATH="$t/bin:$PATH" bash "$t/rotate-secrets.sh" >/dev/null || { echo "FAIL rotate-secrets.sh exited non-zero"; exit 1; }
fail=0
check() { if [[ $2 == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1 → $2 (expected $3)"; fail=1; fi; }
val() { sed -n "s/^$1=//p" "$t/.env"; }
check "plain embed token rotated" "$([[ $(val EMBED_TOKEN_ANNA) =~ ^[0-9a-f]{64}$ ]] && echo yes)" "yes"
check "hash re-derived from the new token" "$(val EMBED_TOKEN_SHA256_ANNA)" "$(printf %s "$(val EMBED_TOKEN_ANNA)" | sha256sum | cut -d' ' -f1)"
check "hash added for a vault that had none" "$(val EMBED_TOKEN_SHA256_BEN)" "$(printf %s "$(val EMBED_TOKEN_BEN)" | sha256sum | cut -d' ' -f1)"
check "one hash line per vault" "$(grep -c '^EMBED_TOKEN_SHA256_' "$t/.env")" "2"
check "MCP token rotated" "$([[ $(val MCP_TOKEN_ANNA) != old-mcp ]] && echo yes)" "yes"
check "unrelated lines kept" "$(val OTHER)" "keep"
check ".env mode 600" "$(stat -c %a "$t/.env")" "600"
exit $fail
