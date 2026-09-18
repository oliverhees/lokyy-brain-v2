#!/usr/bin/env bash
# LBV2-26 — shared embedding service: vector equivalence with the in-process embedder and memory.
#   1. Vectors from the service (through vault-anna, with its token) match the vault's former
#      in-process embedder (same model files, mean pooling, normalized, 8000-char cut) within 1e-5.
#   2. Memory: 200 pages are indexed in vault-anna through the service and 20 hybrid searches run
#      through Traefik; the vault stays below VAULT_RSS_LIMIT_MIB (default 400) the whole time.
#      Peaks of vault-anna and embed are printed (docker stats, 1 s sampling).
#   3. Worst case (audit HIGH-2/MED-2): 16 × 8000 CJK chars in one request are refused by the token
#      budget; 4 × 4 texts of 8000 CJK chars (anna) and 4 × 4 texts of 8000 random single-char tokens
#      (ben) run concurrently at the 2048-token cap and embed stays inside its limit; a search query
#      from firma meanwhile is answered within QUERY_MAX_S (default 15) seconds.
#   4. One layout for web and MCP (LBV2-26 QA): a note created via MCP (anna's vault token, the path
#      MetaMCP uses) is found by the web app's hybrid search, and a note filed through the web app
#      (POST /api/wiki/file) is found by MCP semantic_search — both after the indexer sweep embedded
#      them through the service (MINDBASE_EMBED_SWEEP_MS, default 60 s).
# Run from deploy/stack/ with the stack up: tests/embed.sh   (writes 200 test pages into vault-anna)
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
STACK=${STACK_NAME:-lokyy-stack}
P=${STACK_HTTP_PORT:-18080}
TAG=${IMAGE_TAG:-dev}
LIMIT_MIB=${VAULT_RSS_LIMIT_MIB:-400}
PAGES=${EMBED_TEST_PAGES:-200}
tests/port-gate.sh || exit 1
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

echo "== 3. Worst case: token-heavy input (CJK, random single-char tokens), query latency under load"
# post_from <vault> <token> <body-file> → "<http status> <seconds>"
post_from() {
  docker compose exec -T "$1" sh -c 'cat > /tmp/embed-body.json' <"$3"
  printf 'authorization: Bearer %s\n' "$2" | docker compose exec -T "$1" sh -c \
    'h=$(mktemp); cat >"$h"; curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 300 -X POST -H "content-type: application/json" -H @"$h" --data-binary @/tmp/embed-body.json http://embed:8080/embed; rm -f "$h" /tmp/embed-body.json'
}
node -e '
  const fs = require("fs");
  const cjk = (seed) => { let s = ""; for (let i = 0; i < 8000; i++) s += String.fromCharCode(0x4e00 + ((i + seed) * 7919) % 20900); return s; };
  // Random code points from scripts that tokenize to roughly one token per character
  const ranges = [[0x4e00, 0x9fff], [0x3040, 0x30ff], [0xac00, 0xd7a3], [0x0e00, 0x0e7f], [0x2200, 0x22ff]];
  const rnd = () => { let s = ""; while (s.length < 8000) { const [a, b] = ranges[Math.floor(Math.random() * ranges.length)]; s += String.fromCharCode(a + Math.floor(Math.random() * (b - a))); } return s.slice(0, 8000); };
  fs.writeFileSync(process.argv[1] + "/cjk16.json", JSON.stringify({ texts: Array.from({ length: 16 }, (_, i) => cjk(i)) }));
  for (let r = 0; r < 4; r++) {
    fs.writeFileSync(`${process.argv[1]}/cjk4-${r}.json`, JSON.stringify({ texts: Array.from({ length: 4 }, (_, i) => cjk(r * 4 + i)) }));
    fs.writeFileSync(`${process.argv[1]}/rnd4-${r}.json`, JSON.stringify({ texts: Array.from({ length: 4 }, rnd) }));
  }
  fs.writeFileSync(process.argv[1] + "/query.json", JSON.stringify({ texts: ["Wo steht die Messung des Speicherbedarfs?"] }));
' "$tmp"
expect "16 × 8000 CJK chars in one request: refused by the token budget" "$(post_from vault-anna "$EMBED_TOKEN_ANNA" "$tmp/cjk16.json" | cut -d' ' -f1)" "413"
: >"$tmp/stats"
( while :; do docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "${STACK}-embed-1" 2>/dev/null | awk '{print $1, $2}' >>"$tmp/stats"; sleep 1; done ) &
sampler=$!
( for r in 0 1 2 3; do post_from vault-anna "$EMBED_TOKEN_ANNA" "$tmp/cjk4-$r.json"; echo; done >"$tmp/anna.out" ) &
a_pid=$!
( for r in 0 1 2 3; do post_from vault-ben "$EMBED_TOKEN_BEN" "$tmp/rnd4-$r.json"; echo; done >"$tmp/ben.out" ) &
b_pid=$!
sleep 8
q=$(post_from vault-firma "$EMBED_TOKEN_FIRMA" "$tmp/query.json")
wait "$a_pid" "$b_pid"
kill "$sampler" 2>/dev/null; sampler=
echo "     query under load: ${q#* } s; anna: $(cut -d' ' -f1 "$tmp/anna.out" | tr '\n' ' ')ben: $(cut -d' ' -f1 "$tmp/ben.out" | tr '\n' ' ')"
expect "4 × 4 CJK texts (2048-token cap) all embedded" "$(grep -c '^200 ' "$tmp/anna.out")" "4"
expect "4 × 4 random-token texts all embedded" "$(grep -c '^200 ' "$tmp/ben.out")" "4"
expect "search query under bulk load answered within ${QUERY_MAX_S:-15} s (priority)" \
  "$(awk -v t="${q#* }" -v m="${QUERY_MAX_S:-15}" -v c="${q%% *}" 'BEGIN{print (c == 200 && t < m) ? "ok" : c " " t}')" "ok"
worst=0
while read -r _ usage; do m=$(to_mib "$usage"); (( m > worst )) && worst=$m; done <"$tmp/stats"
limit_mib=$(( $(docker inspect "${STACK}-embed-1" --format '{{.HostConfig.Memory}}') / 1024 / 1024 ))
echo "     embed worst-case peak=${worst} MiB of ${limit_mib} MiB ($(wc -l <"$tmp/stats") samples)"
expect "embed worst-case peak below its mem_limit" "$(( worst > 0 && worst < limit_mib ? 1 : 0 ))" "1"
# docker stats samples once per second and misses short spikes; the cgroup's own high-water mark does not
cg_peak=$(( $(docker compose exec -T embed cat /sys/fs/cgroup/memory.peak | tr -d '\r') / 1024 / 1024 ))
echo "     embed cgroup memory.peak since container start=${cg_peak} MiB of ${limit_mib} MiB"
expect "embed cgroup peak (all sections, incl. spikes) below its mem_limit" "$(( cg_peak > 0 && cg_peak < limit_mib ? 1 : 0 ))" "1"
expect "embed still not OOM-killed / restarted" "$(docker inspect "${STACK}-embed-1" --format '{{.State.OOMKilled}} {{.RestartCount}}')" "false 0"

echo "== 4. Web app and MCP share one store; both find each other's notes semantically"
# mcp_call <tool> <json-args> → tool result text, through vault-anna's MCP port with anna's token (as MetaMCP does)
mcp_call() {
  printf 'authorization: Bearer %s\n' "$MCP_TOKEN_ANNA" | docker compose exec -T metamcp sh -c "h=\$(mktemp); cat >\"\$h\"
    init='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"0\"}}}'
    sid=\$(curl -s -D - -o /dev/null --max-time 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\"\$h\" -d \"\$init\" http://mcp.vault-anna:4322/mcp | tr -d '\\r' | sed -n 's/^mcp-session-id: //Ip')
    curl -s -o /dev/null --max-time 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\"\$h\" -H \"mcp-session-id: \$sid\" -d '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}' http://mcp.vault-anna:4322/mcp
    curl -s --max-time 120 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @\"\$h\" -H \"mcp-session-id: \$sid\" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}' http://mcp.vault-anna:4322/mcp
    rm -f \"\$h\"" | sed -n 's/^data: //p' | tail -1 | jq -r '.result.content[0].text // .error.message // empty'
}
mark=$RANDOM$RANDOM
mcp_title="Okapi Waldgiraffe $mark"
web_title="Zebrafisch Aquarium $mark"
created=$(mcp_call create_note "{\"title\":\"$mcp_title\",\"content\":\"Das Okapi lebt im Regenwald des Kongo und ist mit der Giraffe verwandt.\"}")
expect "MCP create_note in vault-anna" "$(jq -r '.created // empty' <<<"$created" 2>/dev/null)" "true"
mcp_slug=$(jq -r '.slug // empty' <<<"$created" 2>/dev/null)
expect "MCP note lands in the web app's project (projects/default/wiki/notes)" \
  "$(docker compose exec -T vault-anna sh -c "test -f /data/projects/default/wiki/notes/$mcp_slug.md && echo project || echo missing" | tr -d '\r')" "project"
expect "web app files a note (POST /api/wiki/file)" \
  "$(curl -s -b "$jar" -H 'content-type: application/json' -d "{\"title\":\"$web_title\",\"content\":\"Zebrafische sind kleine gestreifte Fische, beliebt im Aquarium und in der Forschung.\"}" "http://anna.vault.localhost:$P/api/wiki/file" | jq -r '.ok')" "true"
web_slug=$(docker compose exec -T vault-anna sh -c "ls /data/projects/default/wiki/notes | grep -i 'zebrafisch-aquarium-$mark' | sed 's/\\.md\$//;s/\\.meta\\.json\$//' | head -1" | tr -d '\r')
# Wait until the indexer sweep has embedded both (one cache file per page)
for _ in $(seq 1 90); do
  n=$(docker compose exec -T vault-anna sh -c "ls /data/embeddings 2>/dev/null | grep -c -e '^$mcp_slug\.json' -e '^$web_slug\.json'" | tr -d '\r')
  [[ ${n:-0} -ge 2 ]] && break
  sleep 2
done
expect "both notes embedded by the indexer sweep (no vault restart)" "${n:-0}" "2"
hy=$(curl -s -b "$jar" -H 'content-type: application/json' -d '{"q":"Tier aus dem Kongo verwandt mit der Giraffe","limit":5}' "http://anna.vault.localhost:$P/api/search/hybrid")
expect "web hybrid search finds the MCP-created note semantically" "$(jq -r --arg s "$mcp_slug" '[.results[] | select(.slug == $s)] | length' <<<"$hy")" "[1-9]"
sem=$(mcp_call semantic_search '{"query":"gestreifte kleine Aquarienfische","limit":5}')
expect "MCP semantic_search finds the web note semantically (top 5)" "$(jq -r --arg s "$web_slug" '[.[] | select(.slug == $s)] | length' <<<"$sem" 2>/dev/null)" "[1-9]"
expect "MCP semantic_search used vectors (scores are cosine, not keyword fallback)" \
  "$(jq -r --arg s "$web_slug" '.[] | select(.slug == $s) | (.score < 1.0001 and .score > 0)' <<<"$sem" 2>/dev/null | head -1)" "true"
docker compose exec -T vault-anna sh -c "rm -f /data/projects/default/wiki/notes/$mcp_slug.* /data/projects/default/wiki/notes/$web_slug.* /data/embeddings/$mcp_slug.json /data/embeddings/$web_slug.json"

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
