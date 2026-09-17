// Round 4 review fixes: an upstream 401 (rotated/removed key) drops the binding and closes its
// streams; every 429 carries Retry-After.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGate, type GateOptions } from '../src/gate.ts';

const revoked = new Set<string>(); // keys the fake MetaMCP rejects with 401
let counter = 0;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (revoked.has(String(req.headers['x-api-key'] ?? ''))) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid_api_key"}'); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: open\n\n');
      const t = setInterval(() => res.write(': ping\n\n'), 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json' };
    if (Buffer.concat(chunks).toString().includes('"initialize"')) { counter += 1; headers['mcp-session-id'] = `ffffffff-1111-4000-8000-${String(counter).padStart(12, '0')}`; }
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
  const g = createGate({ upstream: upstreamUrl, idleMs: 60_000, lifetimeMs: 600_000, maxBindings: 100, maxBodyBytes: 4096, log: () => {}, ...extra });
  gates.push(g);
  await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(g.address() as AddressInfo).port}/metamcp/anna/mcp`;
}
const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
const init = (url: string, key: string) => fetch(url, { method: 'POST', headers: { 'x-api-key': key }, body: INIT });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function openStream(url: string, key: string, sid: string) {
  const res = await fetch(url, { headers: { 'x-api-key': key, 'mcp-session-id': sid, accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const ended = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return true; } } catch { return true; } })();
  return { status: res.status, ended, cancel: () => reader.cancel(), headers: res.headers };
}
const endsWithin = (p: Promise<boolean>, ms: number) => Promise.race([p, sleep(ms).then(() => false)]);

test('an upstream 401 for a bound session drops the binding and closes its streams (rotated key)', async () => {
  const url = await gate();
  const sid = (await init(url, 'key-rotated')).headers.get('mcp-session-id')!;
  const s = await openStream(url, 'key-rotated', sid);
  assert.equal(s.status, 200);
  revoked.add('key-rotated');
  const r = await fetch(url, { method: 'POST', headers: { 'x-api-key': 'key-rotated', 'mcp-session-id': sid }, body: LIST });
  assert.equal(r.status, 401);
  assert.equal(await endsWithin(s.ended, 1_000), true, 'stream closed');
  revoked.delete('key-rotated');
  const again = await fetch(url, { method: 'POST', headers: { 'x-api-key': 'key-rotated', 'mcp-session-id': sid }, body: LIST });
  assert.equal(again.status, 404, 'binding gone');
});

test('429 responses carry Retry-After in seconds (initialize rate and stream cap)', async () => {
  const url = await gate({ initRatePerSec: 1, initBurst: 1 });
  await init(url, 'key-retry');
  const r = await init(url, 'key-retry');
  assert.equal(r.status, 429);
  assert.match(r.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/);

  const url2 = await gate({ maxStreamsPerSession: 1 });
  const sid = (await init(url2, 'key-retry2')).headers.get('mcp-session-id')!;
  const s1 = await openStream(url2, 'key-retry2', sid);
  const s2 = await fetch(url2, { headers: { 'x-api-key': 'key-retry2', 'mcp-session-id': sid, accept: 'text/event-stream' } });
  assert.equal(s2.status, 429);
  assert.match(s2.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/);
  await s1.cancel();
});
