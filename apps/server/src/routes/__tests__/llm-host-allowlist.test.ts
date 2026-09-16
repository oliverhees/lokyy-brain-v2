import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { configRoutes } from '../config.js';
import { semanticSearchRoutes } from '../semantic-search.js';
import type { AtlasConfig } from '../../config.js';

const BASE: AtlasConfig = {
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-live-secret-1234', baseUrl: '',
  autoSave: true, mergeSaves: false, maxContextChars: 50000,
};

// A loopback server stands in for both an internal service and an allowed LLM endpoint.
let llm: Server;
let port = 0;
let base = '';
const hits: Array<{ url: string; auth: string | undefined }> = [];

beforeAll(async () => {
  llm = createServer((req, res) => {
    hits.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: `http://localhost:${port}/v1/models` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] }));
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()));
  port = (llm.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => { await new Promise<void>((r) => llm.close(() => r())); });

describe('LLM endpoint host allow-list (LBV2-19)', () => {
  let outer: string;
  let dataDir: string;
  let ctx: ServerContext;
  let app: express.Application;

  beforeEach(async () => {
    hits.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VAULT_PROXY_SECRET', 'x'.repeat(32));
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', '127.0.0.1,api.eurouter.ai');
    outer = await mkdtemp(join(tmpdir(), 'llm-allowlist-test-'));
    dataDir = join(outer, 'data');
    await mkdir(dataDir, { recursive: true });
    ctx = await createContext(dataDir);
    await ctx.saveConfig({ ...BASE, baseUrl: 'https://api.eurouter.ai/api/v1' });
    app = express();
    app.use(express.json());
    app.use('/api/config', configRoutes(ctx));
    app.use('/api/semantic-search', semanticSearchRoutes(ctx));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(outer, { recursive: true, force: true });
  });

  it.each(['http://169.254.169.254/latest', 'http://10.0.0.1:8080/v1', 'http://localhost:11434'])(
    'PUT rejects baseUrl %s with a generic 400 and keeps the stored config', async (url) => {
      const res = await request(app).put('/api/config').send({ provider: 'openai', model: 'm', apiKey: 'sk-new', baseUrl: url });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'LLM endpoint not allowed' });
      expect(ctx.config.baseUrl).toBe('https://api.eurouter.ai/api/v1');
    },
  );

  it('PUT rejects switching to a provider whose default host is not listed', async () => {
    const res = await request(app).put('/api/config').send({ provider: 'anthropic', model: 'm', apiKey: 'sk-new', baseUrl: '' });
    expect(res.status).toBe(400);
    expect(ctx.config.provider).toBe('openai');
  });

  it('PUT accepts a listed host', async () => {
    const res = await request(app).put('/api/config').send({ provider: 'openai', model: 'm', apiKey: 'sk-new', baseUrl: `${base}/v1` });
    expect(res.status).toBe(200);
    expect(ctx.config.baseUrl).toBe(`${base}/v1`);
  });

  it('PUT of unrelated settings is not blocked by the allow-list', async () => {
    const res = await request(app).put('/api/config').send({ autoSave: false });
    expect(res.status).toBe(200);
  });

  it('POST /test rejects a metadata address with 400 and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'm', apiKey: 'sk-typed', baseUrl: 'http://169.254.169.254' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'LLM endpoint not allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /test works against a listed fake server on 127.0.0.1', async () => {
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'm', apiKey: 'sk-typed', baseUrl: `${base}/v1` });
    expect(res.body).toEqual({ ok: true });
    expect(hits[0]).toEqual({ url: '/v1/models', auth: 'Bearer sk-typed' });
  });

  it('POST /test does not follow a redirect off the listed host', async () => {
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'm', apiKey: 'sk-typed', baseUrl: `${base}/redirect/v1` });
    expect(res.body).toEqual({ ok: false, error: 'Connection test failed' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.url.startsWith('/redirect'))).toBe(true);
  });

  it('guarded mode without VAULT_LLM_ALLOWED_HOSTS fails closed', async () => {
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', '');
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'm', apiKey: 'sk-typed', baseUrl: `${base}/v1` });
    expect(res.status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it('call time: a config file edited on disk to a non-listed host is refused (adapter + semantic search)', async () => {
    await writeFile(join(dataDir, 'mindbase.config.json'), JSON.stringify({ ...BASE, baseUrl: `http://localhost:${port}` }));
    await ctx.reloadConfig();
    expect(ctx.config.baseUrl).toBe(`http://localhost:${port}`);
    const errors: string[] = [];
    for await (const c of ctx.getAdapter().chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
      if (c.kind === 'error') errors.push(c.error);
    }
    expect(errors.join()).toContain('LLM endpoint not allowed');

    await ctx.store.writeText('wiki/notes/a.md', 'hello');
    const res = await request(app).get('/api/semantic-search?q=hello');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('LLM endpoint not allowed');
    expect(hits).toHaveLength(0);
  });

  it('local mode (no proxy secret, no list) is unchanged', async () => {
    vi.stubEnv('VAULT_PROXY_SECRET', '');
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', '');
    vi.stubEnv('VAULT_REQUIRE_PROXY_SECRET', '');
    const url = `http://localhost:${port}/v1`;
    const put = await request(app).put('/api/config').send({ provider: 'openai', model: 'm', apiKey: 'sk-new', baseUrl: url });
    expect(put.status).toBe(200);
    const res = await request(app).post('/api/config/test').send({ provider: 'openai', model: 'm', apiKey: 'sk-typed', baseUrl: url });
    expect(res.body).toEqual({ ok: true });
  });
});
