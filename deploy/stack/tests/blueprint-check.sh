#!/usr/bin/env bash
# LBV2-29 — static check of Authentik blueprints (no containers started).
# A blueprint entry for user akadmin that sets `groups` REPLACES all of akadmin's groups. Without
# "authentik Admins" akadmin loses superuser, the bootstrap API token gets 403 everywhere and the
# admin UI is unusable. So every such entry must keep "authentik Admins" in its group list.
# Usage: tests/blueprint-check.sh [blueprint.yaml ...]   (default: this stack's blueprints)
set -uo pipefail
cd "$(dirname "$0")/.."
(( $# )) || set -- authentik/blueprints/*.yaml

fail=0
for f in "$@"; do
  # One record per top-level entry of `entries:` (lines starting with "  - "), flattened to one line.
  bad=$(awk '
    function flush() { if (e ~ /username:[ ]*"?akadmin"?[ ,}]/ && e ~ /groups:/ && e !~ /"authentik Admins"/) print n; e = "" }
    /^  - / { flush(); n = NR }
    { e = e " " $0 }
    END { flush() }' "$f")
  if [[ -n $bad ]]; then
    for line in $bad; do echo "FAIL $f:$line akadmin groups without \"authentik Admins\""; done
    fail=1
  else
    echo "ok   $f: akadmin keeps \"authentik Admins\""
  fi
done
exit $fail
