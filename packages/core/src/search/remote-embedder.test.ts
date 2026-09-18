import { describe, it, expect, vi } from 'vitest';
import {
  createRemoteEmbedder,
  remoteEmbedderFromEnv,
  EmbedServiceError,
  EMBED_MAX_CHARS,
  REMOTE_EMBED_DEFAULTS,
} from './remote-embedder';

const TOKEN = 'vault-token-0123456789abcdef';
const DIM = 3;

interface Call { url: string; init: RequestInit; texts: string[] }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Fake service: vector [len, index, 1] per text, optional scripted failures first. */
function fakeService(failures: Array<() => Response | Promise<Response>> = []) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { texts: string[] };
    calls.push({ url: String(url), init: init ?? {}, texts: body.texts });
    const next = failures.shift();
    if (next) return next();
    return json(200, { vectors: body.texts.map((t, i) => [t.length, i, 1]), dim: DIM });
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

const noSleep = vi.fn(async () => {});
const make = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof createRemoteEmbedder>[0]> = {}) =>
  createRemoteEmbedder({ url: 'http://embed:8080', token: TOKEN, fetchFn, sleep: noSleep, ...extra });

describe('createRemoteEmbedder', () => {
  it('POSTs {texts} to <url>/embed with the bearer token and refuses redirects', async () => {
    const svc = fakeService();
    const vec = await make(svc.fetchFn, { url: 'http://embed:8080/' }).embed('hello');
    expect(vec).toEqual([5, 0, 1]);
    expect(svc.calls).toHaveLength(1);
    const c = svc.calls[0]!;
    expect(c.url).toBe('http://embed:8080/embed');
    expect(c.init.method).toBe('POST');
    expect(c.init.redirect).toBe('error');
    const headers = new Headers(c.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(c.texts).toEqual(['hello']);
  });

  it('truncates every text to the in-process limit before sending', async () => {
    const svc = fakeService();
    await make(svc.fetchFn).embed('x'.repeat(EMBED_MAX_CHARS + 500));
    expect(EMBED_MAX_CHARS).toBe(8000);
    expect(svc.calls[0]!.texts[0]!.length).toBe(EMBED_MAX_CHARS);
  });

  it('batches embedMany and keeps the input order', async () => {
    const svc = fakeService();
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const vecs = await make(svc.fetchFn, { maxBatch: 2 }).embedMany(texts);
    expect(svc.calls.map((c) => c.texts)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(vecs.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('defaults: batches of at most 4 texts, 90 s timeout (audit MED-1)', async () => {
    const svc = fakeService();
    await make(svc.fetchFn).embedMany(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(svc.calls.map((c) => c.texts.length)).toEqual([4, 4, 1]);
    expect(REMOTE_EMBED_DEFAULTS).toEqual({ timeoutMs: 90_000, retries: 2, backoffMs: 500, maxBatch: 4 });
  });

  it('embedMany of nothing makes no request', async () => {
    const svc = fakeService();
    expect(await make(svc.fetchFn).embedMany([])).toEqual([]);
    expect(svc.calls).toHaveLength(0);
  });

  it('retries 503, 429 (rejected before inference) and connection errors with growing backoff, honouring Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    const svc = fakeService([
      () => json(503, { error: 'busy' }),
      () => { throw new TypeError('fetch failed'); },
      () => json(429, { error: 'rate_limited' }, { 'retry-after': '3' }),
    ]);
    const vec = await make(svc.fetchFn, { retries: 3, backoffMs: 100, sleep }).embed('ok');
    expect(vec).toEqual([2, 0, 1]);
    expect(svc.calls).toHaveLength(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 3000]);
  });

  it('caps Retry-After so a hostile or broken service cannot park the vault', async () => {
    const sleep = vi.fn(async () => {});
    const svc = fakeService([() => json(429, {}, { 'retry-after': '99999' })]);
    await make(svc.fetchFn, { retries: 1, sleep }).embed('ok');
    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(10_000);
  });

  it('gives up after the retries with a clear error that never contains the token', async () => {
    const svc = fakeService(Array.from({ length: 5 }, () => () => json(503, { error: 'busy' })));
    const err = await make(svc.fetchFn, { retries: 2 }).embed('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedServiceError);
    expect((err as EmbedServiceError).status).toBe(503);
    expect((err as Error).message).toMatch(/embedding service unavailable.*HTTP 503.*3 attempts/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(svc.calls).toHaveLength(3);
  });

  it.each([408, 502, 504])('retries HTTP %i (QA: e.g. 408 while the service restarts)', async (status) => {
    const svc = fakeService([() => json(status, { error: 'x' })]);
    expect(await make(svc.fetchFn, { retries: 1 }).embed('ok')).toEqual([2, 0, 1]);
    expect(svc.calls).toHaveLength(2);
  });

  // 500: the service failed on this text (model error, or an inference timeout after which it exits and
  // restarts). Retrying would repeat the same text and could restart the shared service again.
  it.each([400, 401, 403, 404, 413, 415, 500])('does not retry HTTP %i', async (status) => {
    const svc = fakeService([() => json(status, { error: 'x' })]);
    const err = await make(svc.fetchFn, { retries: 3 }).embed('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedServiceError);
    expect((err as EmbedServiceError).status).toBe(status);
    expect(svc.calls).toHaveLength(1);
  });

  it('names a rejected token explicitly', async () => {
    const svc = fakeService([() => json(401, { error: 'unauthorized' })]);
    await expect(make(svc.fetchFn).embed('x')).rejects.toThrow(/rejected the vault token.*MINDBASE_EMBED_TOKEN/);
  });

  it('times out each attempt', async () => {
    const hang = vi.fn((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    }));
    const err = await make(hang as unknown as typeof fetch, { timeoutMs: 20, retries: 3 }).embed('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbedServiceError);
    expect((err as Error).message).toMatch(/timed out after 20 ms/);
    // Audit MED-1: the service may still be working on it; a retry would only add the same load again
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong count', { vectors: [[1, 2, 3], [1, 2, 3]], dim: 3 }],
    ['wrong dim', { vectors: [[1, 2]], dim: 3 }],
    ['not numbers', { vectors: [['a', 'b', 'c']], dim: 3 }],
    ['non-finite', { vectors: [[1, null, 3]], dim: 3 }],
    ['no vectors', { dim: 3 }],
    ['not json', 'garbage'],
  ])('rejects a malformed response (%s)', async (_name, body) => {
    const svc = fakeService([() => (typeof body === 'string' ? new Response(body, { status: 200 }) : json(200, body))]);
    await expect(make(svc.fetchFn, { retries: 0 }).embed('x')).rejects.toThrow(/invalid response/);
  });
});

describe('remoteEmbedderFromEnv', () => {
  it('returns null when neither variable is set (in-process embeddings)', () => {
    expect(remoteEmbedderFromEnv({})).toBeNull();
    expect(remoteEmbedderFromEnv({ MINDBASE_EMBED_URL: '', MINDBASE_EMBED_TOKEN: '' })).toBeNull();
  });

  it('fails closed when only one of URL and token is set', () => {
    expect(() => remoteEmbedderFromEnv({ MINDBASE_EMBED_URL: 'http://embed:8080' })).toThrow(/MINDBASE_EMBED_TOKEN/);
    expect(() => remoteEmbedderFromEnv({ MINDBASE_EMBED_TOKEN: TOKEN })).toThrow(/MINDBASE_EMBED_URL/);
  });

  it.each(['embed:8080', 'ftp://embed/', 'http://user:pw@embed:8080', 'http://embed:8080/?t=1', 'http://embed:8080/#x'])(
    'rejects the URL %s', (url) => {
      expect(() => remoteEmbedderFromEnv({ MINDBASE_EMBED_URL: url, MINDBASE_EMBED_TOKEN: TOKEN })).toThrow(/MINDBASE_EMBED_URL/);
    },
  );

  it('builds an embedder from both variables and never echoes the token in errors', () => {
    expect(remoteEmbedderFromEnv({ MINDBASE_EMBED_URL: 'https://embed.internal', MINDBASE_EMBED_TOKEN: TOKEN })).not.toBeNull();
    try {
      remoteEmbedderFromEnv({ MINDBASE_EMBED_URL: 'nope', MINDBASE_EMBED_TOKEN: TOKEN });
    } catch (e) {
      expect((e as Error).message).not.toContain(TOKEN);
    }
  });

  it('reads optional timeout and retries', async () => {
    const svc = fakeService(Array.from({ length: 9 }, () => () => json(503, {})));
    const r = remoteEmbedderFromEnv(
      { MINDBASE_EMBED_URL: 'http://embed:8080', MINDBASE_EMBED_TOKEN: TOKEN, MINDBASE_EMBED_RETRIES: '1', MINDBASE_EMBED_TIMEOUT_MS: '5000' },
      { fetchFn: svc.fetchFn, sleep: noSleep },
    );
    await expect(r!.embed('x')).rejects.toThrow(/2 attempts/);
  });
});
