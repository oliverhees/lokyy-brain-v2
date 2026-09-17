import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnector } from '../src/connector.ts';

// Fake vault: echoes the Host header it received and streams SSE.
const vault = http.createServer((req, res) => {
  if (req.headers.accept === 'text/event-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: second\n\n'), 300);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ host: req.headers.host, url: req.url, auth: req.headers.authorization ?? null }));
});

let connector: http.Server;
let base: string;
before(async () => {
  await new Promise<void>((r) => vault.listen(0, '127.0.0.1', r));
  const port = (vault.address() as AddressInfo).port;
  // Every allowed vault name maps to the fake vault here; in the stack the target is upstream.vault-<v>:4322.
  connector = createConnector({ vaults: ['anna', 'firma'], target: () => ({ host: '127.0.0.1', port }), log: () => {} });
  await new Promise<void>((r) => connector.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(connector.address() as AddressInfo).port}`;
});
after(() => { connector.close(); vault.close(); });

async function send(host: string, path = '/mcp', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'POST', headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('routes by Host header to the named vault and keeps Host and Authorization', async () => {
  const r = await send('mcp.vault-anna:4322', '/mcp', { authorization: 'Bearer t' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { host: 'mcp.vault-anna:4322', url: '/mcp', auth: 'Bearer t' });
});

test('unknown vault names, other ports and other hosts are refused without contacting a vault', async () => {
  for (const host of ['mcp.vault-ben:4322', 'mcp.vault-anna:4321', 'metamcp:12008', 'mcp.vault-anna', 'evil']) {
    const r = await send(host);
    assert.equal(r.status, 404, host);
  }
});

test('SSE is streamed through', async () => {
  const u = new URL(base);
  const started = Date.now();
  const first = await new Promise<string>((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/mcp', method: 'GET', headers: { host: 'mcp.vault-firma:4322', accept: 'text/event-stream' } }, (res) => {
      res.once('data', (c) => { resolve(String(c)); req.destroy(); });
    });
    req.end();
  });
  assert.match(first, /first/);
  assert.ok(Date.now() - started < 250);
});
