/**
 * Streamable HTTP transport test (LBV2-7).
 * Starts dist/http.js against a fixture wiki and checks token auth + tool round-trip.
 * Run from apps/mcp/ directory: node test/http-transport.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'test-token-0123456789abcdef';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;

const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-http-'));
const notesDir = join(dataDir, 'wiki', 'notes');
mkdirSync(notesDir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(notesDir, 'fixture-page.md'), '# Fixture Page\n\nHTTP transport fixture.');
writeFileSync(join(notesDir, 'fixture-page.meta.json'), JSON.stringify({
  id: 'fixture-page', title: 'Fixture Page', type: 'concept', one_liner: 'Test fixture page',
  edit_state: 'ai_generated', created: now, updated: now, word_count: 4,
}));

let exitCode = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => { console.error(`FAIL ${msg}`); exitCode = 1; };

function startServer(env) {
  return spawn('node', ['dist/http.js'], {
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForExit(proc, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

async function waitForPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(URL_MCP, { method: 'POST' }); return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const initBody = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});
const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function run() {
  // 1. Refuses to start without a token
  const noToken = startServer({ MCP_HTTP_TOKEN: '' });
  const code = await waitForExit(noToken, 5000);
  if (code === null) { noToken.kill(); fail('server started without MCP_HTTP_TOKEN'); }
  else if (code === 0) fail('server exited 0 without MCP_HTTP_TOKEN (expected non-zero)');
  else ok('server refuses to start without MCP_HTTP_TOKEN');

  // 1b. Refuses a weak (short) token
  const weak = startServer({ MCP_HTTP_TOKEN: 'short' });
  const weakCode = await waitForExit(weak, 5000);
  if (weakCode === null) { weak.kill(); fail('server started with a token shorter than 16 chars'); }
  else ok('server refuses a token shorter than 16 chars');

  const proc = startServer({ MCP_HTTP_TOKEN: TOKEN });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen on ${PORT}\n${stderr}`); return; }

    // 2. Missing token → 401
    const r1 = await fetch(URL_MCP, { method: 'POST', headers: jsonHeaders, body: initBody });
    r1.status === 401 ? ok('missing token → 401') : fail(`missing token → ${r1.status} (expected 401)`);

    // 3. Wrong token → 401
    const r2 = await fetch(URL_MCP, { method: 'POST', headers: { ...jsonHeaders, authorization: 'Bearer wrong-token-0123456789' }, body: initBody });
    r2.status === 401 ? ok('wrong token → 401') : fail(`wrong token → ${r2.status} (expected 401)`);

    // 4. Token in query string is NOT accepted (tokens must not end up in logs)
    const r3 = await fetch(`${URL_MCP}?token=${TOKEN}`, { method: 'POST', headers: jsonHeaders, body: initBody });
    r3.status === 401 ? ok('token via query string → 401') : fail(`token via query string → ${r3.status} (expected 401)`);

    // 5. Unknown path → 404 (with valid token)
    const r4 = await fetch(`http://127.0.0.1:${PORT}/other`, { method: 'POST', headers: { ...jsonHeaders, authorization: `Bearer ${TOKEN}` }, body: initBody });
    r4.status === 404 ? ok('unknown path → 404') : fail(`unknown path → ${r4.status} (expected 404)`);

    // 6. Valid token → full MCP round-trip via the SDK client
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    tools.length > 10 ? ok(`tools/list returned ${tools.length} tools`) : fail(`tools/list returned ${tools.length} tools`);

    const res = await client.callTool({ name: 'search_wiki', arguments: { query: 'Fixture Page' } });
    const text = (res.content ?? []).map((c) => c.text ?? '').join('');
    !res.isError && text.includes('fixture-page')
      ? ok('tools/call search_wiki finds fixture page over HTTP')
      : fail(`tools/call search_wiki → ${text.slice(0, 200)}`);

    // 7. Two independent sessions work in parallel
    const client2 = new Client({ name: 'http-test-2', version: '0.0.0' });
    await client2.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
    const { tools: tools2 } = await client2.listTools();
    tools2.length === tools.length ? ok('second concurrent session works') : fail('second session tool count differs');

    await client.close();
    await client2.close();
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().then(() => process.exit(exitCode));
