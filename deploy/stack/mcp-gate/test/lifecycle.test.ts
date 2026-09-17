// Round 3 review fixes: upstream session cleanup on eviction/expiry, initialize rate limit, stream
// limits, streams closed with their binding, single-object initialize, header stripping, global cap.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGate, globalBindingCap, STATIC_BAD_REQUEST, type GateOptions } from '../src/gate.ts';

const deletes: Array<{ sid: string; key: string }> = [];
let forwarded = 0;
let counter = 0;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    forwarded += 1;
    const sid = String(req.headers['mcp-session-id'] ?? '');
    if (req.method === 'DELETE') { deletes.push({ sid, key: String(req.headers['x-api-key'] ?? '') }); res.writeHead(200); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: open\n\n'); // stays open until the client or the gate closes it
      const t = setInterval(() => res.write(': ping\n\n'), 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    const body = Buffer.concat(chunks).toString();
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', location: 'http://metamcp/x', link: '<http://metamcp/y>; rel=next', 'content-location': '/z' };
    if (body.includes('"initialize"')) { counter += 1; headers['mcp-session-id'] = `eeeeeeee-0000-4000-8000-${String(counter).padStart(12, '0')}`; }
    res.writeHead(200, headers);
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
});

let upstreamUrl = '';
const gates: http.Server[] = [];
before(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(() => { for (const g of gates) { g.closeAllConnections(); g.close(); } upstream.closeAllConnections(); upstream.close(); });

async function gate(extra: Partial<GateOptions> = {}) {
  const g = createGate({ upstream: upstreamUrl, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 100, maxBodyBytes: 4096, log: () => {}, initRatePerSec: 1000, initBurst: 1000, ...extra });
  gates.push(g);
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
  return { g, url: `http://127.0.0.1:${(g.address() as AddressInfo).port}/metamcp/anna/mcp` };
}
const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const init = (url: string, key: string) => fetch(url, { method: 'POST', headers: { 'x-api-key': key }, body: INIT });
const sidOf = async (url: string, key: string) => (await init(url, key)).headers.get('mcp-session-id')!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function openStream(url: string, key: string, sid: string) {
  const res = await fetch(url, { headers: { 'x-api-key': key, 'mcp-session-id': sid, accept: 'text/event-stream' } });
  if (res.status !== 200) { await res.body?.cancel(); return { status: res.status, ended: Promise.resolve(true) }; }
  const reader = res.body!.getReader();
  const ended = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return true; } } catch { return true; } })();
  return { status: 200, ended, cancel: () => reader.cancel() };
}
const endsWithin = (p: Promise<boolean>, ms: number) => Promise.race([p, sleep(ms).then(() => false)]);

test('a binding evicted by the per-key cap is deleted upstream with its own key', async () => {
  const { url } = await gate({ maxPerKey: 1 });
  const first = await sidOf(url, 'key-evict');
  deletes.length = 0;
  await sidOf(url, 'key-evict');
  await sleep(100);
  assert.deepEqual(deletes, [{ sid: first, key: 'key-evict' }]);
});

test('an idle-expired binding is deleted upstream by the sweeper', async () => {
  const { url } = await gate({ idleMs: 100, sweepIntervalMs: 50 });
  const sid = await sidOf(url, 'key-idle');
  deletes.length = 0;
  await sleep(400);
  assert.deepEqual(deletes, [{ sid, key: 'key-idle' }]);
});

test('open streams are closed when their binding expires or is deleted', async () => {
  const { url } = await gate({ lifetimeMs: 300, sweepIntervalMs: 50 });
  const sid = await sidOf(url, 'key-life');
  const s = await openStream(url, 'key-life', sid);
  assert.equal(s.status, 200);
  assert.equal(await endsWithin(s.ended, 2_000), true, 'stream closed at binding lifetime');

  const { url: url2 } = await gate();
  const sid2 = await sidOf(url2, 'key-del');
  const s2 = await openStream(url2, 'key-del', sid2);
  assert.equal((await fetch(url2, { method: 'DELETE', headers: { 'x-api-key': 'key-del', 'mcp-session-id': sid2 } })).status, 200);
  assert.equal(await endsWithin(s2.ended, 1_000), true, 'stream closed on DELETE');
});

test('an open stream keeps its session from idling out', async () => {
  const { url } = await gate({ idleMs: 150, sweepIntervalMs: 50 });
  const sid = await sidOf(url, 'key-active');
  const s = await openStream(url, 'key-active', sid);
  await sleep(500);
  assert.equal(await endsWithin(s.ended, 10), false, 'still open');
  s.cancel?.();
});

test('initialize is rate limited per key (429), other keys unaffected', async () => {
  const { url } = await gate({ initRatePerSec: 1, initBurst: 5 });
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await init(url, 'key-rate')).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await init(url, 'key-other')).status, 200);
});

test('open streams are limited per session (2) and per key (10)', async () => {
  const { url } = await gate({ maxStreamsPerSession: 2, maxStreamsPerKey: 3, maxPerKey: 10 });
  const a = await sidOf(url, 'key-streams');
  const b = await sidOf(url, 'key-streams');
  const s1 = await openStream(url, 'key-streams', a);
  const s2 = await openStream(url, 'key-streams', a);
  const s3 = await openStream(url, 'key-streams', a);
  assert.deepEqual([s1.status, s2.status, s3.status], [200, 200, 429]);
  const s4 = await openStream(url, 'key-streams', b);
  const s5 = await openStream(url, 'key-streams', b);
  assert.deepEqual([s4.status, s5.status], [200, 429], 'key limit 3');
  s1.cancel?.();
  await endsWithin(s1.ended, 500);
  await sleep(50);
  const s6 = await openStream(url, 'key-streams', b);
  assert.equal(s6.status, 200, 'a closed stream frees its slot');
  for (const s of [s2, s4, s6]) s.cancel?.();
});

test('only a single initialize object creates a session (batches refused)', async () => {
  const { url } = await gate();
  const before = forwarded;
  const r = await fetch(url, { method: 'POST', headers: { 'x-api-key': 'k' }, body: `[${INIT},{"jsonrpc":"2.0","id":2,"method":"tools/list"}]` });
  assert.equal(r.status, 400);
  assert.equal(await r.text(), STATIC_BAD_REQUEST);
  assert.equal(forwarded, before);
});

test('Location, Content-Location and Link headers are stripped; bodies pass unchanged', async () => {
  // Assumption verified against MetaMCP 2.4.22 / MCP SDK 1.16: session ids only travel in the
  // mcp-session-id header, never in JSON bodies or SSE data, so bodies are not rewritten.
  const { url } = await gate();
  const r = await init(url, 'key-headers');
  assert.equal(r.headers.get('location'), null);
  assert.equal(r.headers.get('content-location'), null);
  assert.equal(r.headers.get('link'), null);
  assert.equal(await r.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
});

test('global cap is derived from the provisioned users and warns above 80 %', async () => {
  assert.equal(globalBindingCap(2, 20), 100, 'minimum 100');
  assert.equal(globalBindingCap(50, 20), 1250, 'users × per-key × 1.25');
  for (let users = 0; users <= 500; users++) assert.ok(globalBindingCap(users, 20) >= users * 20, `cap for ${users} users covers every user's full quota`);
  const lines: string[] = [];
  const { url } = await gate({ maxBindings: 5, maxPerKey: 5, log: (l) => lines.push(l) });
  for (let i = 0; i < 5; i++) await sidOf(url, 'key-fill');
  assert.ok(lines.some((l) => l.includes('WARN bindings')), 'warned when crossing 80 %');
});
