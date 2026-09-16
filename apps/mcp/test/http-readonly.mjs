/**
 * Read-only token profile test (LBV2-10).
 * A session opened with MCP_HTTP_READONLY_TOKEN may only see and call tools on the
 * reviewed read allowlist; everything else — including tools that do not exist yet —
 * is rejected before any handler runs.
 * Run from apps/mcp/ directory: node test/http-readonly.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { READ_ONLY_TOOL_NAMES } from '../dist/index.js';

const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_NAMES);

const FULL = 'full-token-0123456789abcdef-0123456789';
const RO = 'read-token-0123456789abcdef-0123456789';
const PORT = 19000 + Math.floor(Math.random() * 1000);
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;

const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-ro-'));
const notesDir = join(dataDir, 'wiki', 'notes');
mkdirSync(notesDir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(notesDir, 'fixture-page.md'), '# Fixture Page\n\nRead-only fixture.');
writeFileSync(join(notesDir, 'fixture-page.meta.json'), JSON.stringify({
  id: 'fixture-page', title: 'Fixture Page', type: 'concept', one_liner: 'Test fixture page',
  edit_state: 'ai_generated', created: now, updated: now, word_count: 3,
}));

mkdirSync(join(dataDir, 'chats'), { recursive: true });
writeFileSync(join(dataDir, 'chats', 'chat-secret.json'), JSON.stringify({ id: 'chat-secret', title: 'Private chat', messages: [] }));

let exitCode = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => { console.error(`FAIL ${msg}`); exitCode = 1; };

function startServer(env) {
  return spawn('node', ['dist/http.js'], {
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitForExit = (proc, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
});
async function waitForPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(URL_MCP, { method: 'POST' }); return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function connect(token) {
  const client = new Client({ name: 'ro-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
/** Snapshot of every file path + size + mtime under the data dir. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}
async function callRejected(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    return res.isError === true;
  } catch {
    return true;
  }
}

async function run() {
  // 0. The allowlist itself is exported and non-empty
  Array.isArray(READ_ONLY_TOOL_NAMES) && READ_ONLY_TOOL_NAMES.length > 0
    ? ok(`READ_ONLY_TOOL_NAMES exported (${READ_ONLY_TOOL_NAMES.length} tools)`)
    : fail('READ_ONLY_TOOL_NAMES missing or empty');

  // 1. Startup validation
  const same = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: FULL });
  const sameCode = await waitForExit(same, 5000);
  if (sameCode === null || sameCode === 0) { same.kill(); fail('server started with identical full and read-only tokens'); }
  else ok('server refuses identical full and read-only tokens');

  const short = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: 'r'.repeat(31) });
  const shortCode = await waitForExit(short, 5000);
  if (shortCode === null || shortCode === 0) { short.kill(); fail('server started with a short read-only token'); }
  else ok('server refuses a read-only token shorter than 32 chars');

  const proc = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen\n${stderr}`); return; }

    const full = await connect(FULL);
    const ro = await connect(RO);
    const fullTools = (await full.listTools()).tools.map((t) => t.name);
    const roTools = (await ro.listTools()).tools.map((t) => t.name);

    // 2. Allowlist entries are real tools (no stale names)
    const stale = [...READ_ONLY_TOOLS].filter((n) => !fullTools.includes(n));
    stale.length === 0 ? ok('every allowlisted tool exists') : fail(`allowlist has unknown tools: ${stale.join(', ')}`);

    // 3. Read-only list is exactly the allowlist
    const extra = roTools.filter((n) => !READ_ONLY_TOOLS.has(n));
    extra.length === 0 && roTools.length === READ_ONLY_TOOLS.size
      ? ok(`read-only tools/list = allowlist (${roTools.length})`)
      : fail(`read-only tools/list mismatch; extra: ${extra.join(', ')}; got ${roTools.length}`);
    fullTools.includes('create_note') ? ok('full token still lists create_note') : fail('full token lost create_note');
    !roTools.includes('create_note') && !roTools.includes('mindbase_ingest_file')
      ? ok('read-only list hides create_note and mindbase_ingest_file')
      : fail('read-only list exposes write/network tools');

    // 4. Allowed read works
    const read = await ro.callTool({ name: 'search_wiki', arguments: { query: 'Fixture Page' } });
    const text = (read.content ?? []).map((c) => c.text ?? '').join('');
    !read.isError && text.includes('fixture-page') ? ok('read-only search_wiki works') : fail(`read-only search_wiki → ${text.slice(0, 120)}`);

    // 5. Every non-allowlisted tool is rejected without side effects
    const before = snapshot(dataDir);
    const writeTools = fullTools.filter((n) => !READ_ONLY_TOOLS.has(n));
    const notRejected = [];
    for (const name of writeTools) {
      if (!(await callRejected(ro, name, { title: 'ro-attack', body: 'x', content: 'x', text: 'x', slug: 'fixture-page', url: 'http://127.0.0.1:1/', path: '/etc/passwd', query: 'x' }))) {
        notRejected.push(name);
      }
    }
    notRejected.length === 0
      ? ok(`all ${writeTools.length} non-allowlisted tools rejected for read-only token`)
      : fail(`read-only token could call: ${notRejected.join(', ')}`);
    snapshot(dataDir) === before ? ok('data dir unchanged after write attempts') : fail('data dir changed after read-only write attempts');

    // 6. Unknown / future tool names are rejected
    (await callRejected(ro, 'mindbase_future_write_tool', {})) ? ok('unknown tool rejected for read-only token') : fail('unknown tool not rejected');

    // 6b. Resources: read-only sessions see wiki resources but no chat history
    const roResources = (await ro.listResources()).resources.map((r) => r.uri);
    const fullResources = (await full.listResources()).resources.map((r) => r.uri);
    fullResources.some((u) => u.startsWith('mindbase://chats/')) ? ok('full token lists chat resources') : fail('fixture chat not listed for full token');
    !roResources.some((u) => u.startsWith('mindbase://chats/')) && roResources.some((u) => u.startsWith('mindbase://wiki/'))
      ? ok('read-only resources hide chats, keep wiki pages')
      : fail(`read-only resources: ${roResources.join(', ')}`);
    let chatRead = false;
    try { await ro.readResource({ uri: 'mindbase://chats/chat-secret' }); chatRead = true; } catch { /* rejected */ }
    !chatRead ? ok('read-only readResource of a chat rejected') : fail('read-only token could read a chat resource');

    // 7. A session is bound to the token that opened it
    const auth = (t) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}` });
    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hijack', version: '0' } } });
    const roInit = await fetch(URL_MCP, { method: 'POST', headers: auth(RO), body: initBody });
    const roSession = roInit.headers.get('mcp-session-id');
    await roInit.text();
    const hijack = await fetch(URL_MCP, { method: 'POST', headers: { ...auth(FULL), 'mcp-session-id': roSession ?? 'none' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    await hijack.text();
    hijack.status === 403 ? ok('read-only session rejects full token (403)') : fail(`read-only session with full token → ${hijack.status}`);

    const fullInit = await fetch(URL_MCP, { method: 'POST', headers: auth(FULL), body: initBody });
    const fullSession = fullInit.headers.get('mcp-session-id');
    await fullInit.text();
    const downgrade = await fetch(URL_MCP, { method: 'POST', headers: { ...auth(RO), 'mcp-session-id': fullSession ?? 'none' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_note', arguments: { title: 'hijack' } } }) });
    await downgrade.text();
    downgrade.status === 403 ? ok('full session rejects read-only token (403)') : fail(`full session with read-only token → ${downgrade.status}`);

    await full.close().catch(() => {});
    await ro.close().catch(() => {});
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().then(() => process.exit(exitCode));
