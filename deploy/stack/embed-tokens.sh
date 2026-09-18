#!/usr/bin/env bash
# LBV2-26: derives EMBED_TOKEN_SHA256_<VAULT> from every EMBED_TOKEN_<VAULT> in .env (the embed service
# only gets the hashes; each vault gets its own plain token). Idempotent: existing hash lines are
# replaced, nothing else in .env changes. Run after generating or rotating the tokens.
# Usage (from deploy/stack): ./embed-tokens.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || { echo ".env missing" >&2; exit 1; }

umask 077
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
grep -vE '^EMBED_TOKEN_SHA256_[A-Z0-9_]+=' .env >"$tmp" || true
count=0
while IFS= read -r line; do
  if [[ $line =~ ^EMBED_TOKEN_([A-Z0-9_]+)=(.+)$ ]]; then
    printf 'EMBED_TOKEN_SHA256_%s=%s\n' "${BASH_REMATCH[1]}" "$(printf '%s' "${BASH_REMATCH[2]}" | sha256sum | cut -d' ' -f1)" >>"$tmp"
    count=$((count + 1))
  fi
done < <(grep -E '^EMBED_TOKEN_[A-Z0-9_]+=' .env | grep -vE '^EMBED_TOKEN_SHA256_')
(( count > 0 )) || { echo "no EMBED_TOKEN_<VAULT> in .env" >&2; exit 1; }
chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT
echo "wrote $count embed token hashes to .env"
