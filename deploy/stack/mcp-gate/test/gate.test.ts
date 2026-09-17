import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGate, STATIC_NOT_FOUND } from '../src/gate.ts';

// Fake MetaMCP: records requests; initialize creates a session id; unknown sessions answer 404
// with a list of ids (like MetaMCP 2.4.22); GET streams SSE slowly.
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
let counter = 0;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const body = Buffer.concat(chunks).toString();
    if (req.headers['x-api-key'] === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid_api_key","sid":"11111111-2222-4333-8444-555555555555"}'); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: first\n\n');
      setTimeout(() => { res.end('event: message\ndata: second\n\n'); }, 300);
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    if (body.includes('"initialize"')) {
      counter += 1;
      const sid = `aaaaaaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`{"jsonrpc":"2.0","id":2,"result":{"echo":${JSON.stringify(req.url)}}}`);
  });
});

let gate: http.Server;
let base: string;
before(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const up = upstream.address() as AddressInfo;
  gate = createGate({ upstream: `http://127.0.0.1:${up.port}`, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 100, maxBodyBytes: 1024, log: () => {} });
  await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
});
after(() => { gate.close(); upstream.close(); });

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
async function call(path: string, init: { method?: string; key?: string; bearer?: string; sid?: string; body?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (init.key) headers['x-api-key'] = init.key;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.sid) headers['mcp-session-id'] = init.sid;
  const method = init.method ?? 'POST';
  const res = await fetch(base + path, { method, headers, body: method === 'POST' ? (init.body ?? LIST) : undefined });
  return { status: res.status, sid: res.headers.get('mcp-session-id'), text: await res.text() };
}
async function open(endpoint: string, key: string) {
  const r = await call(`/metamcp/${endpoint}/mcp`, { key, body: INIT });
  assert.equal(r.status, 200);
  assert.ok(r.sid);
  return r.sid;
}

test('owner can use the session it initialized (key header or Bearer)', async () => {
  const sid = await open('ben', 'key-ben');
  assert.equal((await call('/metamcp/ben/mcp', { key: 'key-ben', sid })).status, 200);
  assert.equal((await call('/metamcp/ben/mcp', { bearer: 'key-ben', sid })).status, 200);
});

test('another key on its own endpoint cannot use a foreign session id (M2 hijack)', async () => {
  const sid = await open('ben', 'key-ben');
  const before = seen.length;
  const r = await call('/metamcp/anna/mcp', { key: 'key-anna', sid });
  assert.equal(r.status, 404);
  assert.equal(r.text, STATIC_NOT_FOUND);
  assert.equal(seen.length, before, 'request never reaches MetaMCP');
});

test('owner key on another endpoint and missing key are rejected like an unknown session', async () => {
  const sid = await open('ben', 'key-ben');
  const other = await call('/metamcp/anna/mcp', { key: 'key-ben', sid });
  const nokey = await call('/metamcp/ben/mcp', { sid });
  const unknown = await call('/metamcp/ben/mcp', { key: 'key-ben', sid: 'ffffffff-0000-4000-8000-000000000000' });
  for (const r of [other, nokey, unknown]) { assert.equal(r.status, 404); assert.equal(r.text, STATIC_NOT_FOUND); }
});

test('only POST/GET/DELETE on /metamcp/<name>/mcp are forwarded; everything else is a static 404', async () => {
  const before = seen.length;
  for (const [path, method] of [
    ['/metamcp/health/sessions', 'GET'], ['/metamcp/health', 'GET'], ['/metamcp/', 'GET'],
    ['/metamcp/anna/sse', 'GET'], ['/metamcp/anna/api/openapi.json', 'GET'], ['/metamcp/anna/mcp', 'PUT'],
    ['/metamcp/Anna/mcp', 'POST'], ['/metamcp/anna/mcp/x', 'POST'], ['/trpc/frontend.mcpServers.list', 'GET'],
  ] as const) {
    const r = await call(path, { method, key: 'key-anna' });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.text, STATIC_NOT_FOUND);
  }
  assert.equal(seen.length, before);
});

test('upstream error bodies are replaced (no session ids leak) and the query string is dropped', async () => {
  const r = await call('/metamcp/anna/mcp', { key: 'bad', body: INIT });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.text, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  await call('/metamcp/anna/mcp?api_key=x', { key: 'key-anna', body: INIT });
  assert.equal(seen.at(-1)?.url, '/metamcp/anna/mcp');
});

test('DELETE ends the binding', async () => {
  const sid = await open('anna', 'key-anna');
  assert.equal((await call('/metamcp/anna/mcp', { method: 'DELETE', key: 'key-anna', sid })).status, 200);
  assert.equal((await call('/metamcp/anna/mcp', { key: 'key-anna', sid })).status, 404);
});

test('a session id returned for a non-initialize request is not bound', async () => {
  // Fake upstream never does this, so simulate via a second gate against an upstream that always sets a sid.
  const leaky = http.createServer((_req, res) => { res.writeHead(200, { 'mcp-session-id': 'bbbbbbbb-0000-4000-8000-000000000001' }); res.end('{}'); });
  await new Promise<void>((r) => leaky.listen(0, '127.0.0.1', r));
  const g = createGate({ upstream: `http://127.0.0.1:${(leaky.address() as AddressInfo).port}`, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 10, maxBodyBytes: 1024, log: () => {} });
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${(g.address() as AddressInfo).port}/metamcp/anna/mcp`;
  await fetch(u, { method: 'POST', headers: { 'x-api-key': 'k' }, body: LIST });
  const r = await fetch(u, { method: 'POST', headers: { 'x-api-key': 'k', 'mcp-session-id': 'bbbbbbbb-0000-4000-8000-000000000001' }, body: LIST });
  assert.equal(r.status, 404);
  g.close(); leaky.close();
});

test('request bodies above the limit are refused', async () => {
  const r = await call('/metamcp/anna/mcp', { key: 'key-anna', body: 'x'.repeat(2048) });
  assert.equal(r.status, 413);
});

test('SSE responses are streamed, not buffered', async () => {
  const sid = await open('anna', 'key-anna');
  const res = await fetch(`${base}/metamcp/anna/mcp`, { headers: { 'x-api-key': 'key-anna', 'mcp-session-id': sid, accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const started = Date.now();
  const first = await reader.read();
  assert.ok(Date.now() - started < 250, 'first event arrives before the upstream finishes');
  assert.match(new TextDecoder().decode(first.value), /first/);
  await reader.cancel();
});

test('a new gate process knows no sessions (restart forces re-initialize)', async () => {
  const sid = await open('anna', 'key-anna');
  const up = upstream.address() as AddressInfo;
  const fresh = createGate({ upstream: `http://127.0.0.1:${up.port}`, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 10, maxBodyBytes: 1024, log: () => {} });
  await new Promise<void>((r) => fresh.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${(fresh.address() as AddressInfo).port}/metamcp/anna/mcp`, { method: 'POST', headers: { 'x-api-key': 'key-anna', 'mcp-session-id': sid }, body: LIST });
  assert.equal(r.status, 404);
  fresh.close();
});

test('logs never contain keys or session ids', async () => {
  const lines: string[] = [];
  const up = upstream.address() as AddressInfo;
  const g = createGate({ upstream: `http://127.0.0.1:${up.port}`, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 10, maxBodyBytes: 1024, log: (l) => lines.push(l) });
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${(g.address() as AddressInfo).port}/metamcp/anna/mcp`;
  const init = await fetch(u, { method: 'POST', headers: { 'x-api-key': 'secret-key-anna' }, body: INIT });
  const sid = init.headers.get('mcp-session-id')!;
  await fetch(u, { method: 'POST', headers: { 'x-api-key': 'secret-key-anna', 'mcp-session-id': 'cccccccc-0000-4000-8000-000000000009' }, body: LIST });
  g.close();
  const all = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.doesNotMatch(all, /secret-key-anna/);
  assert.ok(!all.includes(sid) && !all.includes('cccccccc-0000-4000-8000-000000000009'));
});
