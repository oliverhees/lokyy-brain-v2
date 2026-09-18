#!/usr/bin/env bash
# LBV2-26 audit HIGH-1: test scripts must never hard-code the default host port. A second stack
# (STACK_HTTP_PORT) would otherwise send its keys to the stack on 18080. Allowed only as a default
# value: ${STACK_HTTP_PORT:-18080} / ${P:-…18080}. Prose in comments (# …) is ignored.
# Every suite runs this first; it also runs on its own: tests/port-gate.sh
set -uo pipefail
cd "$(dirname "$0")"
# -a: metamcp-attacks.sh contains control characters (attack payloads); without -a grep treats it as
# binary and silently prints no matching lines, which is how HIGH-1 slipped through.
hits=$(grep -anE '18080' $(ls ./*.sh ./lib/*.mjs | grep -v '/port-gate\.sh$') 2>/dev/null \
  | grep -vE ':-18080\}' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//)' || true)
if [[ -n $hits ]]; then
  echo "FAIL port gate: hard-coded 18080 (use \$P / \${STACK_HTTP_PORT:-18080}):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "PASS port gate: no hard-coded 18080 in deploy/stack/tests"
