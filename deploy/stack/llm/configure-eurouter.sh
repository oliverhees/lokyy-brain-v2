#!/usr/bin/env bash
# LBV2-5 — point every vault's LLM at EUrouter (OpenAI-compatible).
# Merges provider/baseUrl/model/apiKey into /data/mindbase.config.json inside each vault volume
# (other settings are kept), then restarts the vault if the file changed.
#
# Usage (from deploy/stack, stack running; EUROUTER_API_KEY and EUROUTER_MODEL in .env):
#   llm/configure-eurouter.sh              all vaults
#   llm/configure-eurouter.sh anna firma   selected vaults
# The key is passed to the container by variable name only (never on a command line) and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

: "${EUROUTER_API_KEY:?set EUROUTER_API_KEY in .env}"
: "${EUROUTER_MODEL:?set EUROUTER_MODEL in .env (model id as listed by EUrouter)}"
# API host, not the website: https://www.eurouter.ai/api/v1 answers 404 (HTML)
EUROUTER_BASE_URL=${EUROUTER_BASE_URL:-https://api.eurouter.ai/api/v1}
export EUROUTER_API_KEY EUROUTER_MODEL EUROUTER_BASE_URL

vaults=("$@")
((${#vaults[@]})) || mapfile -t vaults < <(docker compose config --services | sed -n 's/^vault-//p')

for v in "${vaults[@]}"; do
  result=$(docker compose exec -T -e EUROUTER_API_KEY -e EUROUTER_MODEL -e EUROUTER_BASE_URL "vault-$v" node --input-type=module -e '
    import fs from "node:fs";
    const file = `${process.env.MINDBASE_DATA_DIR ?? "/data"}/mindbase.config.json`;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const next = { ...cfg, provider: "openai", baseUrl: process.env.EUROUTER_BASE_URL,
      model: process.env.EUROUTER_MODEL, apiKey: process.env.EUROUTER_API_KEY };
    if (JSON.stringify(next) === JSON.stringify(cfg)) { console.log("unchanged"); process.exit(0); }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    console.log("changed");
  ')
  if [[ $result == changed ]]; then
    docker compose restart "vault-$v" >/dev/null
    echo "vault-$v: EUrouter configured (model $EUROUTER_MODEL), restarted"
  else
    echo "vault-$v: already configured"
  fi
done
