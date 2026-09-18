#!/usr/bin/env bash
# LBV2-26 — shared embedding service: vector equivalence with the in-process embedder and memory.
#   1. Vectors from the service (through vault-anna, with its token) match the vault's former
#      in-process embedder (same model files, mean pooling, normalized, 8000-char cut) within 1e-5.
#   2. Memory: 200 pages are indexed in vault-anna through the service and 20 hybrid searches run
#      through Traefik; the vault stays below VAULT_RSS_LIMIT_MIB (default 400) the whole time.
#      Peaks of vault-anna and embed are printed (docker stats, 1 s sampling).
# Run from deploy/stack/ with the stack up: tests/embed.sh   (writes 200 test pages into vault-anna)
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
STACK=${STACK_NAME:-lokyy-stack}
P=${STACK_HTTP_PORT:-18080}
TAG=${IMAGE_TAG:-dev}
LIMIT_MIB=${VAULT_RSS_LIMIT_MIB:-400}
PAGES=${EMBED_TEST_PAGES:-200}
tests/wait-ready.sh "${WAIT_TIMEOUT:-300}" || exit 1

pass=0 fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
expect() { if [[ "$2" =~ ^($3)$ ]]; then ok "$1 → $2"; else bad "$1 → $2 (expected $3)"; fi; }
tmp=$(mktemp -d)
jar=$(mktemp)
sampler=
cleanup() { [[ -n $sampler ]] && kill "$sampler" 2>/dev/null; rm -rf "$tmp" "$jar"; }
trap cleanup EXIT

echo "== 1. Service vectors equal in-process vectors"
long=$(printf 'Lange Notiz über Wissensgraphen und Vektoren. %.0s' $(seq 1 250))   # > 8000 chars
jq -n --arg long "$long" '["Kurze deutsche Notiz über Embeddings.", "An English sentence about shared services.", "Emoji und Umlaute: äöüß 🚀 — «quotes»", $long]' >"$tmp/texts.json"
# In-process reference: vault image, no network, model read-only (the image's transformers cache points at /models)
docker run --rm -i --network none -v "${STACK}_models:/models:ro" -v "$PWD/tests/lib/inprocess-embed.mjs:/ref.mjs:ro" \
  --entrypoint node "lokyy-brain-v2:$TAG" /ref.mjs <"$tmp/texts.json" >"$tmp/local.json" 2>"$tmp/local.err"
expect "in-process reference computed" "$(jq -r '.vectors | length' "$tmp/local.json" 2>/dev/null)" "4"
# Service, as the vault client sends it: cut at 8000 chars
jq -c '{texts: map(.[0:8000])}' "$tmp/texts.json" >"$tmp/body.json"
printf 'authorization: Bearer %s\n' "$EMBED_TOKEN_ANNA" | docker compose exec -T vault-anna sh -c \
  "umask 077; h=\$(mktemp); cat >\"\$h\"; curl -s --max-time 120 -X POST -H 'content-type: application/json' -H @\$h --data-binary @- http://embed:8080/embed <<'JSON'
$(cat "$tmp/body.json")
JSON
rm -f \"\$h\"" >"$tmp/remote.json"
expect "service answered with 4 vectors" "$(jq -r '.vectors | length' "$tmp/remote.json" 2>/dev/null)" "4"
cmp=$(node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync(process.argv[1])).vectors, b = JSON.parse(fs.readFileSync(process.argv[2])).vectors;
  let minCos = 1, maxAbs = 0;
  a.forEach((v, i) => { let d = 0, na = 0, nb = 0; v.forEach((x, j) => { const y = b[i][j]; d += x * y; na += x * x; nb += y * y; maxAbs = Math.max(maxAbs, Math.abs(x - y)); }); minCos = Math.min(minCos, d / Math.sqrt(na * nb)); });
  console.log(`${minCos >= 0.99999 && maxAbs <= 1e-5 ? "equal" : "DIFFERENT"} minCos=${minCos.toFixed(7)} maxAbs=${maxAbs.toExponential(2)} dim=${a[0].length}/${b[0].length}`);
' "$tmp/local.json" "$tmp/remote.json" 2>&1)
echo "     $cmp"
expect "service vectors equal in-process vectors (cos ≥ 0.99999, |Δ| ≤ 1e-5, same dim)" "${cmp%% *} ${cmp##* }" "equal dim=1024/1024"

echo "== 2. Memory while indexing $PAGES pages and searching (vault limit ${LIMIT_MIB} MiB)"
docker compose exec -T -e PAGES="$PAGES" vault-anna node -e '
  const fs = require("fs"), path = require("path");
  const dir = "/data/projects/default/wiki/notes"; fs.mkdirSync(dir, { recursive: true });   // default project
  const topics = ["Vektorsuche", "Wissensgraph", "Datenschutz", "Kubernetes", "Photosynthese", "Rezepte", "Steuern", "Astronomie"];
  const now = new Date().toISOString();
  for (let i = 0; i < Number(process.env.PAGES); i++) {
    const slug = `embed-ram-${i}`, t = topics[i % topics.length];
    const body = `# ${t} ${i}\n\n` + Array.from({ length: 30 }, (_, k) => `${t} Absatz ${k} der Seite ${i}: Messung des Speicherbedarfs mit geteiltem Embedding-Dienst.`).join("\n");
    fs.writeFileSync(path.join(dir, `${slug}.md`), body);
    fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ id: slug, title: `${t} ${i}`, type: "concept", one_liner: "", edit_state: "ai_generated", created: now, updated: now, word_count: 300 }));
  }
  console.log("seeded");' >/dev/null
# Sample memory once per second: "<vault MiB> <embed MiB>"
( while :; do
    docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "${STACK}-vault-anna-1" "${STACK}-embed-1" 2>/dev/null \
      | awk '{print $1, $2}' >>"$tmp/stats"
    sleep 1
  done ) &
sampler=$!
docker compose restart vault-anna >/dev/null 2>&1
tests/wait-ready.sh 300 >/dev/null || bad "stack ready after vault-anna restart"
# Wait until the indexer has embedded every seeded page (one cache file per page)
for _ in $(seq 1 600); do
  n=$(docker compose exec -T vault-anna sh -c 'ls /data/embeddings 2>/dev/null | grep -c "^embed-ram-"' | tr -d '\r')
  [[ ${n:-0} -ge $PAGES ]] && break
  sleep 2
done
expect "all $PAGES pages embedded through the service" "${n:-0}" "$PAGES"
tests/login.sh "$jar" "http://anna.vault.localhost:$P/" anna "$DEMO_PASS_ANNA" || bad "anna login"
hits=0
for i in $(seq 1 20); do
  r=$(curl -s -b "$jar" -H 'content-type: application/json' -d "{\"q\":\"Speicherbedarf Wissensgraph $i\",\"limit\":5}" "http://anna.vault.localhost:$P/api/search/hybrid")
  [[ $(jq -r '.results | length' <<<"$r" 2>/dev/null) -gt 0 ]] && hits=$((hits+1))
done
expect "20 hybrid searches through Traefik return results" "$hits" "20"
expect "vault-anna never loaded the model (no onnx session in the vault)" \
  "$(docker compose exec -T vault-anna sh -c 'cat /proc/[0-9]*/maps 2>/dev/null | grep -c onnxruntime' | tr -d '\r')" "0"
sleep 2
kill "$sampler" 2>/dev/null; sampler=
to_mib() { local v=$1; case $v in *GiB) awk -v x="${v%GiB}" 'BEGIN{printf "%d", x*1024}';; *MiB) awk -v x="${v%MiB}" 'BEGIN{printf "%d", x}';; *KiB) echo 0;; *) echo 0;; esac; }
vault_peak=0 embed_peak=0
while read -r name usage; do
  m=$(to_mib "$usage")
  if [[ $name == *vault-anna* ]]; then (( m > vault_peak )) && vault_peak=$m; else (( m > embed_peak )) && embed_peak=$m; fi
done <"$tmp/stats"
samples=$(wc -l <"$tmp/stats")
echo "     samples=$samples vault-anna peak=${vault_peak} MiB embed peak=${embed_peak} MiB (docker stats)"
expect "vault-anna peak memory below ${LIMIT_MIB} MiB during indexing and search" "$(( vault_peak < LIMIT_MIB ? 1 : 0 ))" "1"
expect "embed stays below its mem_limit" \
  "$(( embed_peak * 1024 * 1024 < $(docker inspect "${STACK}-embed-1" --format '{{.HostConfig.Memory}}') ? 1 : 0 ))" "1"
expect "embed was not OOM-killed" "$(docker inspect "${STACK}-embed-1" --format '{{.State.OOMKilled}} {{.RestartCount}}')" "false 0"
docker compose exec -T vault-anna sh -c 'rm -f /data/projects/default/wiki/notes/embed-ram-* /data/embeddings/embed-ram-*'

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
