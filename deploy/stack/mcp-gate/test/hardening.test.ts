// Review fixes for mcp-gate: MED-1 (no buffering before auth, server limits), MED-2 (initialize-only
// session creation, per-key cap, fail closed when full), slowloris, LOW-1 (empty key), unbound session ids.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createGate, STATIC_BAD_REQUEST, STATIC_UNAUTHORIZED, type GateOptions } from '../src/gate.ts';

let forwarded = 0;
let counter = 0;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    forwarded += 1;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 300);
      return;
    }
    const isInit = Buffer.concat(chunks).toString().includes('"initialize"');
    counter += 1;
    // Like MetaMCP: every initialize creates a new session id, even when the request carried one.
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json' };
    if (isInit) headers['mcp-session-id'] = `dddddddd-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    res.writeHead(200, headers);
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
});

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
let upstreamUrl = '';
const gates: http.Server[] = [];

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(() => { for (const g of gates) g.close(); upstream.close(); });

async function gate(extra: Partial<GateOptions> = {}) {
  const g = createGate({ upstream: upstreamUrl, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 100, maxBodyBytes: 1024, log: () => {}, ...extra });
  gates.push(g);
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
  const port = (g.address() as AddressInfo).port;
  return { g, port, url: `http://127.0.0.1:${port}/metamcp/anna/mcp` };
}
const post = (url: string, headers: Record<string, string>, body: string) => fetch(url, { method: 'POST', headers, body });

test('requests without a usable key get a static 401 and are never forwarded (MED-1, LOW-1)', async () => {
  const { url } = await gate();
  const before = forwarded;
  for (const headers of [{}, { 'x-api-key': '' }, { 'x-api-key': '   ' }, { authorization: 'Bearer ' }, { authorization: 'Basic abc' }] as Array<Record<string, string>>) {
    const r = await post(url, headers, 'x'.repeat(4096)); // larger than maxBodyBytes: 401, not 413
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(await r.text(), STATIC_UNAUTHORIZED);
  }
  assert.equal(forwarded, before);
});

test('POST without a session id is forwarded only for initialize (MED-2)', async () => {
  const { url } = await gate();
  const before = forwarded;
  const r = await post(url, { 'x-api-key': 'k' }, LIST);
  assert.equal(r.status, 400);
  assert.equal(await r.text(), STATIC_BAD_REQUEST);
  assert.equal(forwarded, before);
});

test('one key opening many sessions never evicts another key; a full gate refuses new keys (MED-2)', async () => {
  const { url } = await gate({ maxBindings: 4, maxPerKey: 2, initBurst: 100 });
  const init = (key: string) => post(url, { 'x-api-key': key }, INIT);
  const use = (key: string, sid: string) => post(url, { 'x-api-key': key, 'mcp-session-id': sid }, LIST).then((r) => r.status);
  const b = (await init('key-b')).headers.get('mcp-session-id')!;
  const a: string[] = [];
  for (let i = 0; i < 6; i++) a.push((await init('key-a')).headers.get('mcp-session-id')!);
  assert.equal(await use('key-b', b), 200, 'B survives A\'s flood');
  assert.equal(await use('key-a', a[0]!), 404, 'A\'s own oldest binding evicted');
  assert.equal(await use('key-a', a[5]!), 200);
  assert.equal((await init('key-c')).status, 200); // A=2, B=1, C=1 → full
  const d = await init('key-d');
  assert.equal(d.status, 503, 'a new key is refused when the gate is full');
  assert.equal(d.headers.get('mcp-session-id'), null);
  assert.equal(await use('key-b', b), 200, 'B still bound');
});

test('a slow request body is cut after the request timeout (slowloris)', async () => {
  const { port } = await gate({ requestTimeoutMs: 400, checkIntervalMs: 100 });
  const result = await new Promise<{ ms: number; data: string }>((resolve) => {
    const started = Date.now();
    let data = '';
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('POST /metamcp/anna/mcp HTTP/1.1\r\nHost: x\r\nx-api-key: k\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"jsonrpc"');
    });
    s.on('data', (c) => (data += c));
    s.on('close', () => resolve({ ms: Date.now() - started, data }));
    setTimeout(() => s.destroy(), 5_000);
  });
  assert.ok(result.ms < 3_000, `connection closed after ${result.ms} ms`);
  assert.doesNotMatch(result.data, / 200 /);
});

test('SSE GET streams outlive the request timeout', async () => {
  const { url } = await gate({ requestTimeoutMs: 100, checkIntervalMs: 50 });
  const sid = (await post(url, { 'x-api-key': 'k' }, INIT)).headers.get('mcp-session-id')!;
  const res = await fetch(url, { headers: { 'x-api-key': 'k', 'mcp-session-id': sid, accept: 'text/event-stream' } });
  assert.match(await res.text(), /first[\s\S]*second/);
});

test('a session id the gate did not bind is stripped (initialize sent on an existing session)', async () => {
  const { url } = await gate();
  const sid = (await post(url, { 'x-api-key': 'k' }, INIT)).headers.get('mcp-session-id')!;
  const r = await post(url, { 'x-api-key': 'k', 'mcp-session-id': sid }, INIT);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), null);
});

test('server limits are set (MED-1)', async () => {
  const { g } = await gate({ maxConnections: 7 });
  assert.equal(g.maxConnections, 7);
  assert.ok(g.headersTimeout > 0 && g.headersTimeout <= 10_000);
  assert.ok(g.keepAliveTimeout > 0 && g.keepAliveTimeout <= 10_000);
});
