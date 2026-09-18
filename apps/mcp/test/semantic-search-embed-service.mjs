/**
 * semantic_search with the shared embedding service (LBV2-26).
 * A fake service stands in for deploy/stack/embed; no LLM is configured. Checks:
 *  - only the query goes to <MINDBASE_EMBED_URL>/embed with the token (audit MED-1: no page embedding on
 *    the query path; pages are embedded by the vault server's indexer),
 *  - cached page vectors (<dataDir>/embeddings) are used only when their content hash matches the page
 *    ("<title>\n\n<body>", the indexer's format); stale or missing vectors are left out,
 *  - results are ranked by the service's vectors,
 *  - a rejected token falls back to keyword search (no LLM call, no model load),
 *  - without the variables the old behaviour stays (LLM required).
 * Run from apps/mcp/ after `pnpm build`: node test/semantic-search-embed-service.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TOKEN = 'mcp-embed-test-token-0123456789';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

// Fake embedding service: apple → x axis, banana → y axis, anything else → z axis.
const requests = [];
let rejectAll = false;
const vectorFor = (t) => (/apple/i.test(t) ? [1, 0, 0] : /banana/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
const service = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ url: req.url, auth: req.headers.authorization, texts: JSON.parse(body).texts });
    if (rejectAll || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    const { texts } = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ vectors: texts.map(vectorFor), dim: 3 }));
  });
});
await new Promise((r) => service.listen(0, '127.0.0.1', r));
const serviceUrl = `http://127.0.0.1:${service.address().port}`;

const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-embed-'));
const notes = join(dataDir, 'wiki', 'notes');
mkdirSync(notes, { recursive: true });
mkdirSync(join(dataDir, 'embeddings'), { recursive: true });
const now = new Date().toISOString();
const page = (slug, title, body) => {
  writeFileSync(join(notes, `${slug}.md`), body);
  writeFileSync(join(notes, `${slug}.meta.json`), JSON.stringify({ id: slug, title, type: 'concept', one_liner: '', edit_state: 'ai_generated', created: now, updated: now, word_count: 3 }));
};
const cache = (slug, content, vector) => writeFileSync(join(dataDir, 'embeddings', `${slug}.json`), JSON.stringify({
  slug, content_hash: createHash('sha256').update(content, 'utf8').digest('hex'), vector, model: 'Xenova/bge-m3', computed_at: now,
}));
// "orchard" has no fruit word in its text, but its cached (server-indexed) vector is the apple axis.
page('orchard', 'Orchard', 'Trees in rows.');
cache('orchard', 'Orchard\n\nTrees in rows.', [1, 0, 0]);
page('banana-bread', 'Banana Bread', 'A banana recipe.');
cache('banana-bread', 'Banana Bread\n\nA banana recipe.', [0, 1, 0]);
// Stale: cached for an older text with the apple vector; the page changed since.
page('apple-stale', 'Apple Stale', 'Now about pears.');
cache('apple-stale', 'Apple Stale\n\nAn apple page.', [1, 0, 0]);
// Never indexed: must not be embedded on the query path.
page('weather', 'Weather', 'Rain tomorrow, apple.');

function startMcp(env) {
  const proc = spawn('node', ['dist/cli.js', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const pending = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* not JSON */ }
    }
  });
  proc.stderr.on('data', () => {});
  let id = 0;
  const call = (name, args) => new Promise((resolve, reject) => {
    id += 1;
    const t = setTimeout(() => reject(new Error(`timeout ${name}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  return { proc, call };
}
const resultText = (msg) => (msg.result?.content ?? []).map((c) => c.text).join('');

try {
  const remote = startMcp({ MINDBASE_EMBED_URL: serviceUrl, MINDBASE_EMBED_TOKEN: TOKEN });
  await new Promise((r) => setTimeout(r, 500));

  const r1 = JSON.parse(resultText(await remote.call('semantic_search', { query: 'apple pie', limit: 3 })));
  check('apple query ranks the page with the cached apple vector first', r1[0]?.slug === 'orchard', JSON.stringify(r1));
  check('scores come from the service vectors', r1[0]?.score > 0.99, JSON.stringify(r1[0]));
  const sent = requests.flatMap((r) => r.texts);
  check('request went to <url>/embed with the vault token', requests.every((r) => r.url === '/embed' && r.auth === `Bearer ${TOKEN}`), JSON.stringify(requests.map((r) => [r.url, r.auth === `Bearer ${TOKEN}`])));
  check('only the query was sent (no page embedding on the query path)', JSON.stringify(sent) === JSON.stringify(['apple pie']), JSON.stringify(sent));
  check('stale cached vector (hash mismatch) is not used', !r1.some((x) => x.slug === 'apple-stale'), JSON.stringify(r1));
  check('page without a cached vector is left out', !r1.some((x) => x.slug === 'weather'), JSON.stringify(r1));

  const r2 = JSON.parse(resultText(await remote.call('semantic_search', { query: 'banana', limit: 1 })));
  check('banana query ranks the banana page first', r2[0]?.slug === 'banana-bread', JSON.stringify(r2));

  rejectAll = true;
  const r3 = await remote.call('semantic_search', { query: 'Weather', limit: 3 });
  const r3r = JSON.parse(resultText(r3));
  check('rejected token: falls back to keyword search', Array.isArray(r3r) && r3r.some((x) => x.slug === 'weather'), resultText(r3));
  rejectAll = false;
  remote.proc.kill();

  const before = requests.length;
  const local = startMcp({ MINDBASE_EMBED_URL: '', MINDBASE_EMBED_TOKEN: '' });
  await new Promise((r) => setTimeout(r, 500));
  const r4 = await local.call('semantic_search', { query: 'apple' });
  check('without the variables: unchanged (LLM required, no service call)', /LLM not configured/.test(resultText(r4)) && requests.length === before, resultText(r4));
  local.proc.kill();

  const half = startMcp({ MINDBASE_EMBED_URL: serviceUrl, MINDBASE_EMBED_TOKEN: '' });
  await new Promise((r) => setTimeout(r, 500));
  const r5 = await half.call('semantic_search', { query: 'Weather' });
  check('only URL set: no service call without a token (keyword fallback)', requests.length === before && /weather/.test(resultText(r5)), resultText(r5));
  half.proc.kill();
} catch (e) {
  check('run', false, e.message);
} finally {
  service.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\n✓ semantic_search embed-service checks passed' : `\n✗ ${failures} semantic_search embed-service checks failed`);
process.exit(failures === 0 ? 0 : 1);
