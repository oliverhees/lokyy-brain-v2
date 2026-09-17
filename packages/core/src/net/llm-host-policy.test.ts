// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  readLlmHostPolicy,
  isLlmUrlAllowed,
  assertLlmUrlAllowed,
  guardLlmFetch,
  effectiveLlmBaseUrl,
  isVaultGuarded,
  logLlmHostPolicy,
  LlmHostNotAllowedError,
  LLM_HOST_NOT_ALLOWED_ERROR,
} from './llm-host-policy';
import { OpenAIAdapter } from '../adapters/openai';
import { AnthropicAdapter } from '../adapters/anthropic';
import { OllamaAdapter } from '../adapters/ollama';
import type { ChatChunk } from '../types';

const GUARDED = { VAULT_PROXY_SECRET: 'x'.repeat(32) };

describe('readLlmHostPolicy (LBV2-19)', () => {
  it('local mode without the variable is not enforced', () => {
    expect(readLlmHostPolicy({})).toEqual({ enforced: false });
  });

  it('guarded mode without the variable fails closed (empty allow-list)', () => {
    const p = readLlmHostPolicy(GUARDED);
    expect(p.enforced).toBe(true);
    expect(p.enforced && p.allowedHosts.size).toBe(0);
  });

  it('VAULT_REQUIRE_PROXY_SECRET alone (MCP process in the image) also counts as guarded', () => {
    expect(readLlmHostPolicy({ VAULT_REQUIRE_PROXY_SECRET: '1' }).enforced).toBe(true);
  });

  it('parses a comma list: trimmed, lowercased, trailing dot removed, empties and invalid entries dropped', () => {
    const p = readLlmHostPolicy({ ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: ' API.EUrouter.ai. , ,127.0.0.1,[::1],::2,Ollama:11434,[::1]:8080,https://x.example,a/b,h:0,h:70000,u@h' });
    expect(p.enforced && [...p.allowedHosts].sort()).toEqual(['127.0.0.1', '::1', '::2', '[::1]:8080', 'api.eurouter.ai', 'ollama:11434']);
  });

  it('isVaultGuarded reflects either proxy variable', () => {
    expect(isVaultGuarded({})).toBe(false);
    expect(isVaultGuarded(GUARDED)).toBe(true);
    expect(isVaultGuarded({ VAULT_REQUIRE_PROXY_SECRET: '1' })).toBe(true);
  });

  it('logLlmHostPolicy warns when enforced with an empty list, is silent in local mode', () => {
    const warn = vi.fn();
    const info = vi.fn();
    logLlmHostPolicy({}, { warn, info });
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toBe('[llm-host-policy] LLM host allowlist not configured; all LLM hosts allowed (unguarded mode)');
    logLlmHostPolicy(GUARDED, { warn, info });
    expect(warn.mock.calls[0]![0]).toMatch(/VAULT_LLM_ALLOWED_HOSTS is not set.*refused/);
    logLlmHostPolicy({ ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai,nope/x' }, { warn, info });
    expect(info.mock.calls[1]![0]).toContain('api.eurouter.ai');
    expect(warn.mock.calls[1]![0]).toMatch(/ignored invalid entr/);
  });

  it('local mode with the variable set is enforced', () => {
    expect(readLlmHostPolicy({ VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai' }).enforced).toBe(true);
  });
});

describe('isLlmUrlAllowed', () => {
  const env = {
    ...GUARDED,
    VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai,127.0.0.1:11434,[::1]:8080,localhost,ollama:11434,::2,plain.example:80,tls.example:443',
  };
  it.each([
    'https://api.eurouter.ai/api/v1',
    'https://API.EUROUTER.AI/api/v1/chat/completions',
    'https://api.eurouter.ai:443/api/v1',
    'http://127.0.0.1:11434',
    'http://[::1]:8080/v1',
    'https://localhost/v1',
    'http://ollama:11434',
    'https://ollama:11434',
    'https://[::2]/v1',
    'http://plain.example/v1',
    'https://tls.example/v1',
    // WHATWG URL parsing canonicalises these to a listed host (no bypass, same destination):
    'https://api.eurouter.ai#@evil.example',
    'https://api.eurouter.ai./v1',
    'http://127.1:11434/v1',
    'http://2130706433:11434/v1',
  ])('allows %s', (url) => expect(isLlmUrlAllowed(url, env)).toBe(true));

  it.each([
    'http://169.254.169.254/latest/meta-data',
    // a bare host is https:443 only; http needs an explicit host:80 entry (audit re-check, Low)
    'http://api.eurouter.ai/api/v1',
    'http://localhost/v1',
    'https://plain.example/v1',
    'https://plain.example:80/v1',
    'http://tls.example/v1',
    'http://tls.example:443/v1',
    // userinfo / canonicalisation tricks resolve to a non-listed host or port
    'https://api.eurouter.ai@evil.example/',
    'https://api.eurouter.ai:443@evil.example/',
    'http://127.1/v1',
    'http://2130706433/v1',
    'https://2130706433/v1',
    'http://localhost:6379',
    'http://localhost:11434',
    'https://api.eurouter.ai:8443/v1',
    'http://api.eurouter.ai:443/v1',
    'http://127.0.0.1/v1',
    'http://ollama/v1',
    'http://[::1]/v1',
    'http://[::2]:8080',
    'https://api.eurouter.ai.attacker.example/v1',
    'https://eurouter.ai/v1',
    'ftp://api.eurouter.ai/x',
    'not a url',
    '',
  ])('refuses %j', (url) => expect(isLlmUrlAllowed(url, env)).toBe(false));

  it('a host:port entry allows exactly that port', () => {
    expect(isLlmUrlAllowed('https://api.eurouter.ai:8443/v1', { ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai:8443' })).toBe(true);
    expect(isLlmUrlAllowed('https://api.eurouter.ai/v1', { ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai:8443' })).toBe(false);
  });

  it('refuses everything in guarded mode without a list', () => {
    expect(isLlmUrlAllowed('https://api.openai.com', GUARDED)).toBe(false);
  });

  it('allows anything in local mode', () => {
    expect(isLlmUrlAllowed('http://169.254.169.254', {})).toBe(true);
  });

  it('assertLlmUrlAllowed throws the generic error', () => {
    expect(() => assertLlmUrlAllowed('http://10.0.0.1', GUARDED)).toThrow(LlmHostNotAllowedError);
    expect(() => assertLlmUrlAllowed('http://10.0.0.1', GUARDED)).toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
  });
});

describe('effectiveLlmBaseUrl', () => {
  it('uses provider defaults for an empty baseUrl', () => {
    expect(effectiveLlmBaseUrl('openai', '')).toBe('https://api.openai.com');
    expect(effectiveLlmBaseUrl('anthropic', undefined)).toBe('https://api.anthropic.com');
    expect(effectiveLlmBaseUrl('deepseek', '')).toBe('https://api.deepseek.com');
    expect(effectiveLlmBaseUrl('ollama', '')).toBe('http://localhost:11434');
    expect(effectiveLlmBaseUrl('openai', 'https://api.eurouter.ai/api/v1')).toBe('https://api.eurouter.ai/api/v1');
  });
});

let server: Server;
let base = '';
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/off-host') {
      res.writeHead(302, { location: 'http://localhost:1/stolen' });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (req.url === '/same-host') {
      res.writeHead(307, { location: '/ok' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => { hits.length = 0; vi.restoreAllMocks(); });

describe('guardLlmFetch', () => {
  let allowLoopback: Record<string, string> = {};
  beforeAll(() => { allowLoopback = { ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: new URL(base).host }; });

  it('a bare listed host does not allow a non-default port on it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(guardLlmFetch(fetch, { ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: '127.0.0.1' })(`${base}/v1/models`))
      .rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
    expect(hits).toHaveLength(0);
  });

  it('keeps method, headers and body of a Request object', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const req = new Request(`${base}/v1/chat`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{"a":1}' });
    await guardLlmFetch(inner as unknown as typeof fetch, allowLoopback)(req);
    const [url, init] = inner.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${base}/v1/chat`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer k');
    expect(await new Response(init.body).text()).toBe('{"a":1}');
    expect(init.redirect).toBe('manual');
  });

  it('refuses a Request object to a non-listed host', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = vi.fn();
    await expect(guardLlmFetch(inner as unknown as typeof fetch, allowLoopback)(new Request('http://169.254.169.254/x')))
      .rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes an allowed host through (fake server on 127.0.0.1 listed)', async () => {
    const r = await guardLlmFetch(fetch, allowLoopback)(`${base}/v1/models`);
    expect(r.status).toBe(200);
    expect(hits).toEqual(['/v1/models']);
  });

  it('refuses a non-listed host before any request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = vi.fn();
    await expect(guardLlmFetch(inner as unknown as typeof fetch, allowLoopback)('http://169.254.169.254/latest'))
      .rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
    expect(inner).not.toHaveBeenCalled();
  });

  it('refuses a redirect to another host and never requests it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(guardLlmFetch(fetch, allowLoopback)(`${base}/off-host`)).rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
    expect(hits).toEqual(['/off-host']);
  });

  it('refuses an off-host redirect even when the target host is also listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...GUARDED, VAULT_LLM_ALLOWED_HOSTS: `${new URL(base).host},localhost:1` };
    await expect(guardLlmFetch(fetch, env)(`${base}/off-host`)).rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
  });

  it('logs "too many redirects" (not a host/port refusal) for a same-origin redirect loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(guardLlmFetch(fetch, allowLoopback)(`${base}/loop`)).rejects.toThrow(LLM_HOST_NOT_ALLOWED_ERROR);
    expect(hits).toHaveLength(6);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('too many redirects');
    expect(logged).not.toContain('host or port not allowed');
  });

  it('follows a same-origin redirect', async () => {
    const r = await guardLlmFetch(fetch, allowLoopback)(`${base}/same-host`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect(hits).toEqual(['/same-host', '/ok']);
  });

  it('local mode passes the call through unchanged', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    await guardLlmFetch(inner as unknown as typeof fetch, {})('http://169.254.169.254/x', { method: 'GET' });
    expect(inner).toHaveBeenCalledWith('http://169.254.169.254/x', { method: 'GET' });
  });
});

describe('adapters refuse non-allowed hosts at call time (LBV2-19)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
  }

  it.each([
    ['openai', (f: typeof fetch) => new OpenAIAdapter({ apiKey: 'sk', model: 'm', baseUrl: 'http://169.254.169.254', fetchImpl: f })],
    ['anthropic', (f: typeof fetch) => new AnthropicAdapter({ apiKey: 'sk', model: 'm', baseUrl: 'http://10.0.0.5', fetchImpl: f })],
    ['ollama', (f: typeof fetch) => new OllamaAdapter({ apiKey: '', model: 'm', fetchImpl: f })],
  ] as const)('%s: chat and testConnection never call fetch and surface the error', async (_name, make) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VAULT_PROXY_SECRET', 'x'.repeat(32));
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', 'api.eurouter.ai');
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const adapter = make(inner as unknown as typeof fetch);
    const chunks = await drain(adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    expect(chunks.some((c) => c.kind === 'error' && c.error.includes(LLM_HOST_NOT_ALLOWED_ERROR))).toBe(true);
    const test = await adapter.testConnection();
    expect(test.ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
  });

  it('local mode: adapters call the configured URL as before', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const adapter = new OpenAIAdapter({ apiKey: 'sk', model: 'm', baseUrl: 'http://127.0.0.1:9', fetchImpl: inner as unknown as typeof fetch });
    expect((await adapter.testConnection()).ok).toBe(true);
    expect(inner).toHaveBeenCalledWith('http://127.0.0.1:9/v1/models', expect.any(Object));
  });
});
