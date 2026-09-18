#!/usr/bin/env bash
# LBV2-26 audit HIGH-1: code and config under deploy/ must never hard-code the default host port. A
# second stack (STACK_HTTP_PORT) would otherwise send its keys to the stack on 18080. Allowed are only
# the default expressions themselves — ${VAR:-18080} (also nested) and the Authentik blueprint's
# !Env [STACK_HTTP_PORT, "18080"] — which are removed before the check, so a literal elsewhere on the
# same line still fails. Full-line comments (# or //) and Markdown are ignored.
# Every suite runs this first; on its own: tests/port-gate.sh   (PORT_GATE_ROOT overrides the tree, for
# tests/port-gate-selftest.sh)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=${PORT_GATE_ROOT:-$(cd "$here/../.." && pwd)}   # deploy/
# -a: metamcp-attacks.sh contains control characters (attack payloads); without -a grep treats it as
# binary and silently prints no matching lines, which is how HIGH-1 slipped through.
hits=$(grep -rnaE '18080' "$root" \
    --include='*.sh' --include='*.mjs' --include='*.js' --include='*.ts' --include='*.yml' --include='*.yaml' \
    --include='*.json' --include='*.toml' --include='Dockerfile' --include='.env.example' \
    --exclude='port-gate.sh' --exclude='port-gate-selftest.sh' --exclude-dir=node_modules 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//)' \
  | sed -E 's/\$\{[A-Za-z_][A-Za-z0-9_]*:-18080\}//g; s/!Env \[[A-Z_]+, "18080"\]//g' \
  | grep -E '^[^:]+:[0-9]+:.*18080' || true)
if [[ -n $hits ]]; then
  echo "FAIL port gate: hard-coded 18080 (use \$P / \${STACK_HTTP_PORT:-18080}):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "PASS port gate: no hard-coded 18080 in deploy/"
