import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbedService, hashToken, type EmbedServiceOptions } from '../src/service.ts';

const TOKEN_ANNA = 'a'.repeat(64);
const TOKEN_BEN = 'b'.repeat(64);
const DIM = 4;

interface Harness {
  base: string;
  server: http.Server;
  logs: string[];
  calls: string[];
  close: () => Promise<void>;
}

// Fake model: vector derived from the text length; `gate` lets a test hold inference.
async function start(overrides: Partial<EmbedServiceOptions> = {}): Promise<Harness> {
  const logs: string[] = [];
  const calls: string[] = [];
  const server = createEmbedService({
    tokens: new Map([['anna', hashToken(TOKEN_ANNA)], ['ben', hashToken(TOKEN_BEN)]]),
    embedOne: async (text) => { calls.push(text); return [text.length, 1, 0, 0]; },
    dim: DIM,
    maxTexts: 4,
    maxChars: 50,
    maxBodyBytes: 1024,
    ratePerSec: 100,
    burst: 100,
    maxPendingPerVault: 4,
    maxQueue: 16,
    queueTimeoutMs: 5_000,
    isReady: () => true,
    log: (l) => logs.push(l),
    ...overrides,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    logs,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}, path = '/embed') {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.close(); });

test('valid token: vectors in request order with dim', async () => {
  const r = await post(h.base, { texts: ['a', 'bbb', ''] }, auth(TOKEN_ANNA));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { vectors: [[1, 1, 0, 0], [3, 1, 0, 0], [0, 1, 0, 0]], dim: DIM });
});

test('the token identifies the vault in the log', async () => {
  await post(h.base, { texts: ['x'] }, auth(TOKEN_BEN));
  assert.ok(h.logs.some((l) => /vault=ben .*status=200/.test(l)), h.logs.join('\n'));
});

test('missing, wrong and malformed tokens get one generic 401 and never reach the model', async () => {
  const before = h.calls.length;
  for (const headers of [{}, auth('c'.repeat(64)), { authorization: TOKEN_ANNA }, { authorization: `Basic ${TOKEN_ANNA}` }, auth('')]) {
    const r = await post(h.base, { texts: ['secret text'] }, headers);
    assert.equal(r.status, 401);
    assert.equal(r.text, '{"error":"unauthorized"}');
  }
  const q = await post(h.base, { texts: ['x'] }, {}, `/embed?token=${TOKEN_ANNA}`);
  assert.equal(q.status, 401, 'token in the query string is ignored');
  assert.equal(h.calls.length, before);
});

test('the bearer scheme is case-insensitive', async () => {
  assert.equal((await post(h.base, { texts: ['x'] }, { authorization: `bearer ${TOKEN_ANNA}` })).status, 200);
});

test('unknown paths and methods: generic 404/405, no model call', async () => {
  const before = h.calls.length;
  assert.equal((await post(h.base, { texts: ['x'] }, auth(TOKEN_ANNA), '/v1/embeddings')).status, 404);
  assert.equal((await post(h.base, { texts: ['x'] }, auth(TOKEN_ANNA), '/embed/../admin')).status, 404);
  const g = await fetch(`${h.base}/embed`, { headers: auth(TOKEN_ANNA) });
  assert.equal(g.status, 405);
  assert.equal(await g.text(), '{"error":"method_not_allowed"}');
  assert.equal(h.calls.length, before);
});

test('healthz answers without a token and reflects model readiness', async () => {
  assert.equal((await fetch(`${h.base}/healthz`)).status, 200);
  const cold = await start({ isReady: () => false });
  try {
    assert.equal((await fetch(`${cold.base}/healthz`)).status, 503);
    const r = await post(cold.base, { texts: ['x'] }, auth(TOKEN_ANNA));
    assert.equal(r.status, 503);
    assert.equal(r.text, '{"error":"unavailable"}');
  } finally { await cold.close(); }
});

test('invalid bodies are rejected with a generic 400', async () => {
  const cases: unknown[] = [
    'not json',
    '[]',
    {},
    { texts: 'x' },
    { texts: [] },
    { texts: ['a', 'b', 'c', 'd', 'e'] },          // > maxTexts
    { texts: [1] },
    { texts: [null] },
    { texts: ['x'.repeat(51)] },                     // > maxChars
    { texts: ['x'], model: 'other' },               // unknown key
  ];
  const before = h.calls.length;
  for (const body of cases) {
    const r = await post(h.base, body, auth(TOKEN_ANNA));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.text, '{"error":"bad_request"}');
  }
  assert.equal(h.calls.length, before);
});

test('non-JSON content type: 415', async () => {
  const r = await post(h.base, JSON.stringify({ texts: ['x'] }), { ...auth(TOKEN_ANNA), 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('bodies over the limit: 413 by content-length and while streaming (chunked)', async () => {
  const big = JSON.stringify({ texts: ['x'.repeat(2000)] });
  assert.equal((await post(h.base, big, auth(TOKEN_ANNA))).status, 413);
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${h.base}/embed`);
    const req = http.request({ host: u.hostname, port: u.port, path: '/embed', method: 'POST', headers: { ...auth(TOKEN_ANNA), 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    for (let i = 0; i < 20; i++) req.write('x'.repeat(100));
    req.end();
  });
  assert.equal(status, 413);
});

test('per-vault rate limit (texts per second) with Retry-After; other vaults unaffected', async () => {
  const s = await start({ ratePerSec: 0.5, burst: 3 });
  try {
    assert.equal((await post(s.base, { texts: ['a', 'b'] }, auth(TOKEN_ANNA))).status, 200);
    const r = await post(s.base, { texts: ['c', 'd'] }, auth(TOKEN_ANNA));
    assert.equal(r.status, 429);
    assert.equal(r.text, '{"error":"rate_limited"}');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await post(s.base, { texts: ['e', 'f', 'g'] }, auth(TOKEN_BEN))).status, 200);
  } finally { await s.close(); }
});

// Holds inference until release() is called; records the order texts were embedded in.
function heldModel() {
  const order: string[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => { release = r; });
  return {
    order,
    release: () => release(),
    reset: () => { gate = new Promise<void>((r) => { release = r; }); },
    embedOne: async (text: string) => { await gate; order.push(text); return [1, 0, 0, 0]; },
  };
}

test('per-vault pending cap (429) and global queue cap (503)', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne, maxPendingPerVault: 2, maxQueue: 3 });
  try {
    const p1 = post(s.base, { texts: ['a1'] }, auth(TOKEN_ANNA));
    const p2 = post(s.base, { texts: ['a2'] }, auth(TOKEN_ANNA));
    await new Promise((r) => setTimeout(r, 50));
    const r3 = await post(s.base, { texts: ['a3'] }, auth(TOKEN_ANNA));
    assert.equal(r3.status, 429, 'third pending request of the same vault');
    const b1 = post(s.base, { texts: ['b1'] }, auth(TOKEN_BEN));
    await new Promise((r) => setTimeout(r, 50));
    const b2 = await post(s.base, { texts: ['b2'] }, auth(TOKEN_BEN));
    assert.equal(b2.status, 503, 'global queue full');
    assert.equal(b2.text, '{"error":"busy"}');
    m.release();
    for (const r of await Promise.all([p1, p2, b1])) assert.equal(r.status, 200);
  } finally { await s.close(); }
});

test('fair scheduling: texts are embedded round-robin across vaults', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne });
  try {
    const a = post(s.base, { texts: ['a1', 'a2', 'a3', 'a4'] }, auth(TOKEN_ANNA));
    await new Promise((r) => setTimeout(r, 30));
    const b = post(s.base, { texts: ['b1'] }, auth(TOKEN_BEN));
    await new Promise((r) => setTimeout(r, 30));
    m.release();
    await Promise.all([a, b]);
    assert.ok(m.order.indexOf('b1') <= 2, `ben waited for all of anna's texts: ${m.order.join(',')}`);
  } finally { await s.close(); }
});

test('queue timeout: a request that waits too long gets 503 and its texts are dropped', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne, queueTimeoutMs: 100 });
  try {
    const a = post(s.base, { texts: ['slow'] }, auth(TOKEN_ANNA));
    const b = await post(s.base, { texts: ['late'] }, auth(TOKEN_BEN));
    assert.equal(b.status, 503);
    m.release();
    await a;
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!m.order.includes('late'));
  } finally { await s.close(); }
});

test('a client that disconnects cancels its remaining texts', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne });
  try {
    const ctl = new AbortController();
    const a = fetch(`${s.base}/embed`, { method: 'POST', signal: ctl.signal, headers: { ...auth(TOKEN_ANNA), 'content-type': 'application/json' }, body: JSON.stringify({ texts: ['c1', 'c2', 'c3', 'c4'] }) }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await a;
    await new Promise((r) => setTimeout(r, 50));
    m.release();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(m.order.length <= 1, `embedded after disconnect: ${m.order.join(',')}`);
  } finally { await s.close(); }
});

test('model errors and wrong dimensions: generic 500 without details', async () => {
  const s = await start({ embedOne: async (t) => { if (t === 'boom') throw new Error('onnx failed at /models/secret/path'); return [1, 2]; } });
  try {
    for (const texts of [['boom'], ['wrong-dim']]) {
      const r = await post(s.base, { texts }, auth(TOKEN_ANNA));
      assert.equal(r.status, 500);
      assert.equal(r.text, '{"error":"internal"}');
    }
    assert.ok(!s.logs.join('\n').includes('/models/secret/path'));
  } finally { await s.close(); }
});

test('logs contain neither text content nor tokens', async () => {
  const s = await start();
  try {
    await post(s.base, { texts: ['very private sentence'] }, auth(TOKEN_ANNA));
    await post(s.base, { texts: ['another private sentence'] }, auth('d'.repeat(64)));
    const all = s.logs.join('\n');
    assert.ok(s.logs.length >= 2);
    assert.ok(!all.includes('private sentence'));
    assert.ok(!all.includes(TOKEN_ANNA) && !all.includes('d'.repeat(64)));
    assert.ok(!all.includes(hashToken(TOKEN_ANNA)));
  } finally { await s.close(); }
});

test('responses are JSON with nosniff and no-store', async () => {
  const r = await post(h.base, { texts: ['x'] }, auth(TOKEN_ANNA));
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('source binding: a vault token is only accepted from that vault network', async () => {
  const s = await start({ sources: new Map([['anna', [{ base: 0x0a000000, bits: 8 }]]]) });
  try {
    // Requests come from 127.0.0.1: anna is bound to 10.0.0.0/8, ben is unbound.
    const r = await post(s.base, { texts: ['x'] }, auth(TOKEN_ANNA));
    assert.equal(r.status, 401);
    assert.equal(r.text, '{"error":"unauthorized"}');
    assert.equal((await post(s.base, { texts: ['x'] }, auth(TOKEN_BEN))).status, 200);
  } finally { await s.close(); }
  const ok = await start({ sources: new Map([['anna', [{ base: 0x7f000000, bits: 8 }]]]) });
  try {
    assert.equal((await post(ok.base, { texts: ['x'] }, auth(TOKEN_ANNA))).status, 200);
  } finally { await ok.close(); }
});

test('per-request token budget (audit HIGH-2): over the budget is 413 before any inference', async () => {
  const s = await start({ countTokens: (t) => t.length, maxRequestTokens: 10 });
  try {
    const r = await post(s.base, { texts: ['aaaaaa', 'bbbbbb'] }, auth(TOKEN_ANNA));
    assert.equal(r.status, 413);
    assert.equal(r.text, '{"error":"too_large"}');
    assert.equal(s.calls.length, 0);
    assert.equal((await post(s.base, { texts: ['aaaaa', 'bbbbb'] }, auth(TOKEN_ANNA))).status, 200);
  } finally { await s.close(); }
});

test('short requests (search queries) go before bulk indexing, also between texts of a running bulk job (audit MED-2)', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne, priorityMaxChars: 5, maxChars: 50 });
  try {
    const long = (p: string) => `${p}-${'x'.repeat(20)}`;
    const a = post(s.base, { texts: [long('a1'), long('a2'), long('a3')] }, auth(TOKEN_ANNA));
    await new Promise((r) => setTimeout(r, 30));
    const b = post(s.base, { texts: [long('b1'), long('b2')] }, auth(TOKEN_BEN));
    await new Promise((r) => setTimeout(r, 30));
    const q = post(s.base, { texts: ['q'] }, auth(TOKEN_ANNA));
    await new Promise((r) => setTimeout(r, 30));
    m.release();
    await Promise.all([a, b, q]);
    assert.equal(m.order.indexOf('q'), 1, `query waited behind bulk texts: ${m.order.join(',')}`);
  } finally { await s.close(); }
});

test('a stuck inference fails its request and reports it, it does not hang forever (audit LOW)', async () => {
  let stuck = 0;
  const s = await start({
    embedOne: (t) => (t === 'hang' ? new Promise<number[]>(() => {}) : Promise.resolve([1, 0, 0, 0])),
    inferenceTimeoutMs: 100,
    onStuck: () => { stuck += 1; },
  });
  try {
    const r = await post(s.base, { texts: ['hang'] }, auth(TOKEN_ANNA));
    assert.equal(r.status, 500);
    assert.equal(r.text, '{"error":"internal"}');
    assert.equal(stuck, 1);
    assert.ok(s.logs.some((l) => /inference timeout/.test(l)));
  } finally { await s.close(); }
});

test('a query arriving while bulk texts run synchronously (ONNX blocks the event loop) is not queued behind the whole bulk request', async () => {
  const order: string[] = [];
  const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* inference */ } };
  const s = await start({
    priorityMaxChars: 5,
    maxTexts: 10,
    embedOne: (t) => { busy(30); order.push(t); return Promise.resolve([1, 0, 0, 0]); },
  });
  try {
    const bulkTexts = Array.from({ length: 10 }, (_, i) => `b${i}-${'x'.repeat(20)}`);
    const bulk = post(s.base, { texts: bulkTexts }, auth(TOKEN_ANNA));
    await new Promise((r) => setTimeout(r, 20));
    const q = post(s.base, { texts: ['q'] }, auth(TOKEN_BEN));
    await Promise.all([bulk, q]);
    assert.ok(order.indexOf('q') < 8, `query only after the whole bulk request: ${order.join(',')}`);
  } finally { await s.close(); }
});

test('a vault that keeps the priority lane full cannot starve bulk indexing: every Nth text goes to bulk (audit)', async () => {
  const m = heldModel();
  const s = await start({ embedOne: m.embedOne, priorityMaxChars: 5, bulkEvery: 3, maxPendingPerVault: 20, maxQueue: 40 });
  try {
    const long = (p: string) => `${p}-${'x'.repeat(20)}`;
    const bulk = post(s.base, { texts: [long('b1'), long('b2')] }, auth(TOKEN_BEN));
    await new Promise((r) => setTimeout(r, 30));
    const flood = Array.from({ length: 12 }, (_, i) => post(s.base, { texts: [`q${i}`] }, auth(TOKEN_ANNA)));
    await new Promise((r) => setTimeout(r, 50));
    m.release();
    await Promise.all([bulk, ...flood]);
    // b1 was already running; b2 must come within the next 3 slots, not after all 12 queries
    assert.ok(m.order.indexOf(long('b2')) <= 4, `bulk starved by the priority lane: ${m.order.join(',')}`);
    assert.ok(m.order.indexOf('q0') <= 2, `queries lost their priority: ${m.order.join(',')}`);
  } finally { await s.close(); }
});
