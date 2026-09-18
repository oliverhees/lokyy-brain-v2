#!/usr/bin/env bash
# LBV2-26: self-test for tests/port-gate.sh on a temporary tree (PORT_GATE_ROOT).
set -uo pipefail
cd "$(dirname "$0")"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
run() { PORT_GATE_ROOT="$t" ./port-gate.sh >/dev/null 2>&1; echo $?; }
check() { if [[ $2 == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1 → exit $2 (expected $3)"; fail=1; fi; }
mkdir -p "$t/stack/tests" "$t/coolify"
printf 'P=${STACK_HTTP_PORT:-18080}\nP=${P:-${STACK_HTTP_PORT:-18080}}\n# prose about 18080\n' >"$t/stack/tests/ok.sh"
printf '      external_host: !Format ["http://a:%%s", !Env [STACK_HTTP_PORT, "18080"]]\n' >"$t/stack/bp.yaml"
printf 'Docs may mention http://x:18080 freely\n' >"$t/README.md"
check "defaults, comments and markdown are allowed" "$(run)" "0"
printf 'curl http://mcp.localhost:18080/x  "${STACK_HTTP_PORT:-18080}"\n' >"$t/stack/tests/bad.sh"
check "a literal next to a default expression on the same line fails" "$(run)" "1"
rm "$t/stack/tests/bad.sh"
printf 'ports: ["127.0.0.1:18080:80"]\n' >"$t/coolify/compose.yml"
check "literal anywhere under deploy/ (not only tests/) fails" "$(run)" "1"
rm "$t/coolify/compose.yml"
printf 'const u = "http://x:18080";\n' >"$t/stack/lib.ts"
check "literal in TypeScript fails" "$(run)" "1"
exit $fail
