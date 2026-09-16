/**
 * SSRF regression test (LBV2-13).
 * An "internal service" listens on 127.0.0.1 and serves a canary. Over the HTTP transport,
 * mindbase_ingest_file (URL mode) and add_rss_feed must not reach it — neither directly nor
 * through a redirect chain. With MINDBASE_ALLOW_PRIVATE_FETCH=1 the same URLs work
 * (escape hatch for local single-user setups).
 * Run from apps/mcp/ directory: node test/ssrf.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'ssrf-token-0123456789abcdef-0123456789';
const CANARY = 'CANARY-SSRF-4b1d-INTERNAL';
const PORT_BLOCKED = 21000 + Math.floor(Math.random() * 500);
const PORT_ALLOWED = PORT_BLOCKED + 500;
const GENERIC = 'URL not allowed or unreachable';
// Anything that would turn the error into an oracle for internal names, addresses or ports.
const LEAKY = /127\.0\.0\.1|localhost|169\.254|ffff|ECONNREFUSED|ENOTFOUND|blocked|private|resolve/i;

let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

const outer = mkdtempSync(join(tmpdir(), 'mb-ssrf-'));
const hits = [];
const internal = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/r1') { res.writeHead(302, { location: '/r2' }); res.end(); return; }
  if (req.url === '/r2') { res.writeHead(301, { location: `http://127.0.0.1:${internal.address().port}/secret.txt` }); res.end(); return; }
  if (req.url === '/secret.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(CANARY); return; }
  if (req.url === '/huge.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.alloc(21 * 1024 * 1024, 'a')); return; }
  if (req.url === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>${CANARY}</title><link>http://x/</link></channel></rss>`);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => internal.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${internal.address().port}`;

function startServer(port, extraEnv) {
  const dataDir = join(outer, `vault-${port}`);
  mkdirSync(join(dataDir, 'wiki', 'notes'), { recursive: true });
  mkdirSync(join(dataDir, 'projects', 'demo'), { recursive: true });
  const env = { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_TOKEN: TOKEN, ...extraEnv };
  if (!extraEnv.MINDBASE_ALLOW_PRIVATE_FETCH) delete env.MINDBASE_ALLOW_PRIVATE_FETCH;
  const proc = spawn('node', ['dist/http.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderrText = '';
  proc.stderr.on('data', (c) => { proc.stderrText += c.toString(); });
  return proc;
}

async function connect(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const client = new Client({ name: 'ssrf', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  }));
  return client;
}

/** The `error` field of a tool error result (exact text the client sees). */
const errorOf = (res) => {
  try { return JSON.parse(res.content?.[0]?.text ?? '{}').error; } catch { return res.content?.[0]?.text; }
};

const call = (client, name, args) => client.callTool({ name, arguments: args })
  .catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }));

const procs = [];
async function run() {
  // 1. Default: private targets are blocked.
  procs.push(startServer(PORT_BLOCKED, {}));
  const client = await connect(PORT_BLOCKED);
  const urls = {
    'direct loopback': `${base}/secret.txt`,
    'redirect chain to loopback': `${base}/r1`,
    'localhost name': `http://localhost:${internal.address().port}/secret.txt`,
    'IPv4-mapped IPv6 loopback': `http://[::ffff:127.0.0.1]:${internal.address().port}/secret.txt`,
    'cloud metadata address': 'http://169.254.169.254/latest/meta-data/',
  };
  for (const [label, path] of Object.entries(urls)) {
    const res = await call(client, 'mindbase_ingest_file', { projectId: 'demo', path });
    const text = JSON.stringify(res);
    if (text.includes(CANARY)) fail(`ingest_file ${label} leaked the canary`);
    else if (!res.isError) fail(`ingest_file ${label} was accepted`);
    else if (errorOf(res) !== GENERIC || LEAKY.test(text)) fail(`ingest_file ${label} error is not generic: ${text.slice(0, 200)}`);
    else ok(`ingest_file ${label} rejected with the generic error`);
  }
  const feed = await call(client, 'add_rss_feed', { url: `${base}/feed.xml` });
  const feedText = JSON.stringify(feed);
  if (feedText.includes(CANARY)) fail('add_rss_feed leaked the canary');
  else if (!feed.isError || errorOf(feed) !== GENERIC || LEAKY.test(feedText)) fail(`add_rss_feed internal URL error not generic: ${feedText.slice(0, 200)}`);
  else ok('add_rss_feed internal URL rejected with the generic error');
  hits.length === 0 ? ok('internal service received no request') : fail(`internal service was hit: ${hits.join(', ')}`);
  await client.close().catch(() => {});

  // 2. Escape hatch: MINDBASE_ALLOW_PRIVATE_FETCH=1 allows them again.
  procs.push(startServer(PORT_ALLOWED, { MINDBASE_ALLOW_PRIVATE_FETCH: '1' }));
  const local = await connect(PORT_ALLOWED);
  const allowed = await call(local, 'mindbase_ingest_file', { projectId: 'demo', path: `${base}/r1` });
  !allowed.isError && JSON.stringify(allowed).includes(CANARY)
    ? ok('MINDBASE_ALLOW_PRIVATE_FETCH=1 follows the redirect chain to the private target')
    : fail(`escape hatch did not work: ${JSON.stringify(allowed).slice(0, 300)}\n${procs[1].stderrText}`);
  // Even with private targets allowed, errors must not reveal ports, addresses or HTTP statuses.
  for (const [label, path] of [['too large (21MB, cap 20MB)', `${base}/huge.txt`], ['refused port','http://127.0.0.1:1/x.txt'], ['HTTP 404', `${base}/missing.txt`], ['unresolvable name', 'http://does-not-exist.invalid/x.txt']]) {
    const res = await call(local, 'mindbase_ingest_file', { projectId: 'demo', path });
    const text = JSON.stringify(res);
    res.isError && errorOf(res) === GENERIC && !LEAKY.test(text) && !text.includes('404') && !text.includes('does-not-exist')
      ? ok(`ingest_file ${label} → generic error`) : fail(`ingest_file ${label} error reveals details: ${text.slice(0, 300)}`);
  }
  await local.close().catch(() => {});
}

run()
  .catch((e) => fail(`${e.message}\n${procs.map((p) => p.stderrText).join('\n')}`))
  .finally(() => {
    for (const p of procs) p.kill('SIGTERM');
    internal.close();
    rmSync(outer, { recursive: true, force: true });
    process.exit(exitCode);
  });
