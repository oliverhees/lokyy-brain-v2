#!/usr/bin/env bash
# LBV2-5 — key selection of llm/configure-eurouter.sh (dry run: no stack changes, no key values).
# Run from deploy/stack: tests/eurouter-keys.sh
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0 fail=0
expect() { if [[ "$2" == "$3" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 → $2 (expected $3)"; fail=$((fail+1)); fi; }
run() { env -u EUROUTER_API_KEY -u EUROUTER_API_KEY_ANNA -u EUROUTER_API_KEY_BEN -u EUROUTER_API_KEY_FIRMA "$@" llm/configure-eurouter.sh --dry-run anna ben firma 2>&1 | tr '\n' ';'; }

expect "no keys: every vault skipped" "$(run)" "vault-anna: none (skipped);vault-ben: none (skipped);vault-firma: none (skipped);"
expect "shared key only" "$(run EUROUTER_API_KEY=s3cr3t-shared)" "vault-anna: EUROUTER_API_KEY;vault-ben: EUROUTER_API_KEY;vault-firma: EUROUTER_API_KEY;"
expect "per-vault key overrides the shared key" "$(run EUROUTER_API_KEY=s3cr3t-shared EUROUTER_API_KEY_FIRMA=s3cr3t-firma)" \
  "vault-anna: EUROUTER_API_KEY;vault-ben: EUROUTER_API_KEY;vault-firma: EUROUTER_API_KEY_FIRMA;"
expect "per-vault key only: other vaults skipped" "$(run EUROUTER_API_KEY_ANNA=s3cr3t-anna)" \
  "vault-anna: EUROUTER_API_KEY_ANNA;vault-ben: none (skipped);vault-firma: none (skipped);"
out=$(run EUROUTER_API_KEY=s3cr3t-shared EUROUTER_API_KEY_ANNA=s3cr3t-anna)
expect "dry run never prints key values" "$([[ $out == *s3cr3t* ]] && echo leaked || echo clean)" "clean"

echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
