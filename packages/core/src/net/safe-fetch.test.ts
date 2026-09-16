// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { classifyAddress, isPublicAddress, safeFetch, SafeFetchError, type ResolvedAddress } from './safe-fetch';

describe('classifyAddress', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '100.64.0.1', '100.127.255.255',
    '169.254.169.254', '169.254.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:0.0.0.0', '::127.0.0.1',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:c0a8:101::',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '192.169.0.1', '169.253.255.255', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8',
    '64:ff9b::808:808', '2002:808:808::1',
  ];
  it.each(blocked)('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
    expect(classifyAddress(ip)).not.toBe('public');
  });
  it.each(allowed)('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
    expect(classifyAddress(ip)).toBe('public');
  });
  it.each(['', 'localhost', '256.0.0.1', '1.2.3', '01.2.3.4', ':::1', '1::2::3', 'gg::1'])('treats %j as invalid (not public)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
    expect(classifyAddress(ip)).toBe('invalid');
  });
});

let server: Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '/';
    if (url === '/hello') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); return; }
    if (url === '/secret') { res.writeHead(200); res.end('SECRET'); return; }
    if (url === '/to-loopback') { res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); res.end(); return; }
    if (url === '/to-mapped') { res.writeHead(307, { location: `http://[::ffff:127.0.0.1]:${port}/secret` }); res.end(); return; }
    if (url === '/to-internal-name') { res.writeHead(301, { location: `http://internal.test:${port}/secret` }); res.end(); return; }
    if (url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return; }
    if (url === '/relative') { res.writeHead(302, { location: '/hello' }); res.end(); return; }
    if (url.startsWith('/loop')) { res.writeHead(302, { location: `/loop${Number(url.slice(5) || 0) + 1}` }); res.end(); return; }
    if (url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
    if (url === '/gzip-bomb') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(100_000, 'a')));
      return;
    }
    if (url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('compressed hello')); return; }
    if (url === '/hang') return; // never answers
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  hits.length = 0;
  delete process.env['MINDBASE_ALLOW_PRIVATE_FETCH'];
});

/** Test resolver with fixed answers; records every lookup. */
function resolver(map: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const addrs = map[hostname];
    if (!addrs) throw new Error(`ENOTFOUND ${hostname}`);
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, calls };
}

async function expectCode(p: Promise<unknown>, code: SafeFetchError['code']): Promise<SafeFetchError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SafeFetchError);
  expect((err as SafeFetchError).code).toBe(code);
  return err as SafeFetchError;
}

describe('safeFetch URL policy', () => {
  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/plain,hi', 'not a url'])('rejects %s', async (url) => {
    await expectCode(safeFetch(url), 'bad_url');
  });

  it('rejects plain http when httpsOnly is set', async () => {
    await expectCode(safeFetch('http://example.com/', { httpsOnly: true }), 'bad_url');
  });

  it('rejects loopback, mapped and metadata IP literals without connecting', async () => {
    await expectCode(safeFetch(`http://127.0.0.1:${port}/secret`), 'blocked');
    await expectCode(safeFetch(`http://[::ffff:127.0.0.1]:${port}/secret`), 'blocked');
    await expectCode(safeFetch(`http://[::1]:${port}/secret`), 'blocked');
    await expectCode(safeFetch('http://169.254.169.254/latest/meta-data/'), 'blocked');
    await expectCode(safeFetch(`http://0x7f000001:${port}/secret`), 'blocked');
    expect(hits).toEqual([]);
  });

  it('rejects a DNS name that resolves to a private address', async () => {
    const { resolve } = resolver({ 'metadata.test': ['169.254.169.254'], 'mixed.test': ['93.184.216.34', '10.0.0.7'] });
    const err = await expectCode(safeFetch('http://metadata.test/latest/', { resolve }), 'blocked');
    expect(err.message).not.toContain('169.254');
    await expectCode(safeFetch('http://mixed.test/', { resolve }), 'blocked');
  });

  it('rejects localhost via the system resolver', async () => {
    await expectCode(safeFetch(`http://localhost:${port}/secret`), 'blocked');
    expect(hits).toEqual([]);
  });
});

describe('safeFetch connection and redirects', () => {
  const trustedHosts = ['start.test'];

  it('connects to the pinned address of a trusted host (one lookup per hop)', async () => {
    const { resolve, calls } = resolver({ 'start.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://start.test:${port}/hello`, { resolve, trustedHosts });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.url).toBe(`http://start.test:${port}/hello`);
    expect(calls).toEqual(['start.test']);
  });

  it('rejects a redirect to a loopback IP literal', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    await expectCode(safeFetch(`http://start.test:${port}/to-loopback`, { resolve, trustedHosts }), 'blocked');
    await expectCode(safeFetch(`http://start.test:${port}/to-mapped`, { resolve, trustedHosts }), 'blocked');
    expect(hits).not.toContain('/secret');
  });

  it('re-resolves and rejects a redirect to a name with a private address', async () => {
    const { resolve, calls } = resolver({ 'start.test': ['127.0.0.1'], 'internal.test': ['10.0.0.5'] });
    await expectCode(safeFetch(`http://start.test:${port}/to-internal-name`, { resolve, trustedHosts }), 'blocked');
    expect(calls).toEqual(['start.test', 'internal.test']);
    expect(hits).not.toContain('/secret');
  });

  it('rejects a redirect to a non-http scheme', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    await expectCode(safeFetch(`http://start.test:${port}/to-file`, { resolve, trustedHosts }), 'bad_url');
  });

  it('follows relative redirects and reports the final URL', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://start.test:${port}/relative`, { resolve, trustedHosts });
    expect(await res.text()).toBe('hello');
    expect(res.url).toBe(`http://start.test:${port}/hello`);
  });

  it('stops after maxRedirects (default 5)', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    await expectCode(safeFetch(`http://start.test:${port}/loop0`, { resolve, trustedHosts }), 'too_many_redirects');
    expect(hits).toHaveLength(6);
  });

  it('enforces maxBytes, also after decompression', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    await expectCode(safeFetch(`http://start.test:${port}/big`, { resolve, trustedHosts, maxBytes: 1000 }), 'too_large');
    await expectCode(safeFetch(`http://start.test:${port}/gzip-bomb`, { resolve, trustedHosts, maxBytes: 10_000 }), 'too_large');
    const ok = await safeFetch(`http://start.test:${port}/gzip`, { resolve, trustedHosts });
    expect(await ok.text()).toBe('compressed hello');
  });

  it('times out', async () => {
    const { resolve } = resolver({ 'start.test': ['127.0.0.1'] });
    await expectCode(safeFetch(`http://start.test:${port}/hang`, { resolve, trustedHosts, timeoutMs: 200 }), 'timeout');
  });
});

describe('private fetch escape hatch', () => {
  it('allows private targets with allowPrivate: true', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/hello`, { allowPrivate: true });
    expect(await res.text()).toBe('hello');
  });

  it('allows private targets when MINDBASE_ALLOW_PRIVATE_FETCH=1', async () => {
    process.env['MINDBASE_ALLOW_PRIVATE_FETCH'] = '1';
    const res = await safeFetch(`http://127.0.0.1:${port}/to-loopback`);
    expect(await res.text()).toBe('SECRET');
  });

  it('keeps blocking for any other value of MINDBASE_ALLOW_PRIVATE_FETCH', async () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env['MINDBASE_ALLOW_PRIVATE_FETCH'] = v;
      await expectCode(safeFetch(`http://127.0.0.1:${port}/hello`), 'blocked');
    }
  });
});
