#!/usr/bin/env bash
# LBV2-5 — point every vault's LLM at EUrouter (OpenAI-compatible).
# Merges provider/baseUrl/model/apiKey into /data/mindbase.config.json inside each vault volume
# (other settings are kept), then restarts the vault if the file changed.
#
# Key per vault (first match wins):
#   EUROUTER_API_KEY_<VAULT>   per-vault key, vault name upper case, "-" → "_" (e.g. EUROUTER_API_KEY_ANNA)
#   EUROUTER_API_KEY           shared key for all vaults without their own key
#   neither                    vault is skipped with a warning, nothing is written
#
# Usage (from deploy/stack, stack running; keys and EUROUTER_MODEL in .env):
#   llm/configure-eurouter.sh [--dry-run] [vault...]     default: all vaults
# --dry-run prints which key source each vault would use (never values) and changes nothing.
# Keys are passed to the container by variable name only (never on a command line) and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

dry_run=0
[[ ${1:-} == --dry-run ]] && { dry_run=1; shift; }

# API host, not the website: https://www.eurouter.ai/api/v1 answers 404 (HTML)
EUROUTER_BASE_URL=${EUROUTER_BASE_URL:-https://api.eurouter.ai/api/v1}

vaults=("$@")
((${#vaults[@]})) || mapfile -t vaults < <(docker compose config --services | sed -n 's/^vault-//p')

key_source() { # key_source <vault> → name of the variable holding its key, or empty
  local per="EUROUTER_API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$1")"
  if [[ -n ${!per:-} ]]; then echo "$per"
  elif [[ -n ${EUROUTER_API_KEY:-} ]]; then echo EUROUTER_API_KEY
  fi
}

if ((dry_run)); then
  for v in "${vaults[@]}"; do
    src=$(key_source "$v")
    echo "vault-$v: ${src:-none (skipped)}"
  done
  exit 0
fi

: "${EUROUTER_MODEL:?set EUROUTER_MODEL in .env (model id as listed by EUrouter)}"
failed=0
for v in "${vaults[@]}"; do
  src=$(key_source "$v")
  if [[ -z $src ]]; then
    echo "WARNING vault-$v: no EUROUTER_API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$v") and no EUROUTER_API_KEY — skipped" >&2
    continue
  fi
  LOKYY_LLM_KEY=${!src}
  export LOKYY_LLM_KEY EUROUTER_MODEL EUROUTER_BASE_URL
  if ! result=$(docker compose exec -T -e LOKYY_LLM_KEY -e EUROUTER_MODEL -e EUROUTER_BASE_URL "vault-$v" node --input-type=module -e '
    import fs from "node:fs";
    const file = `${process.env.MINDBASE_DATA_DIR ?? "/data"}/mindbase.config.json`;
    let cfg = {};
    if (fs.existsSync(file)) {
      try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { console.log("parse-error"); process.exit(3); } // never discard an existing config
    }
    const next = { ...cfg, provider: "openai", baseUrl: process.env.EUROUTER_BASE_URL,
      model: process.env.EUROUTER_MODEL, apiKey: process.env.LOKYY_LLM_KEY };
    if (JSON.stringify(next) === JSON.stringify(cfg)) { console.log("unchanged"); process.exit(0); }
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });                     // a leftover could carry other permissions
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    console.log("changed");
  '); then
    echo "ERROR vault-$v: ${result:-update failed} (existing config left untouched)" >&2
    failed=1
    continue
  fi
  if [[ $result == changed ]]; then
    docker compose restart "vault-$v" >/dev/null
    echo "vault-$v: EUrouter configured (key from $src, model $EUROUTER_MODEL), restarted"
  else
    echo "vault-$v: already configured (key from $src)"
  fi
done
exit "$failed"
