import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { configRoutes } from '../config.js';
import { requireConfigAdmin } from '../../lib/proxy-identity.js';
import { MASKED_SECRET } from '../../lib/config-secrets.js';
import type { AtlasConfig } from '../../config.js';

// EUrouter routing rules (LBV2-30): ruleId in the config, the route picker
// endpoint and the key-checking connection test.
const EU = 'https://api.eurouter.ai/api/v1';
const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
const OTHER_RULE = '11111111-2222-4333-8444-555555555555';
const KEY = 'eur_live_secret_1234';
const BASE: AtlasConfig = {
  provider: 'openai', model: 'qwen3.6-27b', apiKey: KEY, baseUrl: EU,
  autoSave: true, mergeSaves: false, maxContextChars: 50000,
};
const ADMIN = { 'x-authentik-groups': 'vault-admin' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stands in for EUrouter: a rule list for KEY, 401 for any other key. */
function mockEurouter() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url === `${EU}/routing-rules`) {
      if (auth !== `Bearer ${KEY}` && auth !== 'Bearer eur_new_key') return json({ error: `bad key ${auth}` }, 401);
      return json({ data: [
        { id: RULE, name: 'EU only', description: 'd', model: 'mistral/mistral-large', user_id: 'u1' },
        { id: OTHER_RULE, name: 'Cheap', model: null },
      ] });
    }
    if (url === `${EU}/chat/completions`) {
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return json({ data: [] });
  });
}

describe('EUrouter routing rules (LBV2-30)', () => {
  let outer: string;
  let ctx: ServerContext;
  let app: express.Application;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VAULT_PROXY_SECRET', 'x'.repeat(32));
    vi.stubEnv('VAULT_ADMIN_GROUPS', 'vault-admin');
    vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', 'api.eurouter.ai');
    outer = await mkdtemp(join(tmpdir(), 'eurouter-rules-test-'));
    const dataDir = join(outer, 'data');
    await mkdir(dataDir, { recursive: true });
    ctx = await createContext(dataDir);
    await ctx.saveConfig({ ...BASE });
    app = express();
    app.use(express.json());
    app.use('/api/config', requireConfigAdmin(process.env));
    app.use('/api/config', configRoutes(ctx));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(outer, { recursive: true, force: true });
  });

  describe('config', () => {
    it('PUT stores a rule id without key re-entry and GET returns it', async () => {
      const got = await request(app).get('/api/config');
      const res = await request(app).put('/api/config').set(ADMIN).send({ ...got.body, ruleId: RULE });
      expect(res.status).toBe(200);
      expect(ctx.config.ruleId).toBe(RULE);
      expect(ctx.config.apiKey).toBe(KEY);
      expect((await request(app).get('/api/config')).body.ruleId).toBe(RULE);
    });

    it('PUT refuses a rule id that is not a UUID', async () => {
      const res = await request(app).put('/api/config').set(ADMIN).send({ ruleId: 'EU only' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid EUrouter rule id');
      expect(ctx.config.ruleId).toBeUndefined();
    });

    it('PUT with an empty rule id clears it', async () => {
      await ctx.saveConfig({ ...BASE, ruleId: RULE });
      expect((await request(app).put('/api/config').set(ADMIN).send({ ruleId: '' })).status).toBe(200);
      expect(ctx.config.ruleId).toBeUndefined();
    });

    it('PUT drops the rule id when the endpoint is no longer EUrouter (and still needs the key)', async () => {
      vi.stubEnv('VAULT_LLM_ALLOWED_HOSTS', 'api.eurouter.ai,api.openai.com');
      await ctx.saveConfig({ ...BASE, ruleId: RULE });
      const masked = await request(app).put('/api/config').set(ADMIN)
        .send({ provider: 'openai', baseUrl: '', apiKey: MASKED_SECRET, ruleId: RULE });
      expect(masked.status).toBe(400);
      const res = await request(app).put('/api/config').set(ADMIN)
        .send({ provider: 'openai', baseUrl: '', apiKey: 'sk-new', ruleId: RULE });
      expect(res.status).toBe(200);
      expect(ctx.config.ruleId).toBeUndefined();
    });

    it('the server adapter sends the stored rule as rule_id', async () => {
      const fetchSpy = mockEurouter();
      await ctx.saveConfig({ ...BASE, ruleId: RULE });
      const adapter = ctx.getAdapter();
      for await (const _c of adapter.chat({ model: ctx.config.model, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
      const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as Record<string, unknown>;
      expect(body['rule_id']).toBe(RULE);
      expect(body['model']).toBe('qwen3.6-27b');
    });
  });

  describe('GET /api/config/eurouter/rules', () => {
    it('is admin-only in guarded mode, even though it is a GET', async () => {
      const fetchSpy = mockEurouter();
      const res = await request(app).get('/api/config/eurouter/rules');
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('lists id, name and model with the stored key', async () => {
      const fetchSpy = mockEurouter();
      const res = await request(app).get('/api/config/eurouter/rules').set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ rules: [
        { id: RULE, name: 'EU only', model: 'mistral/mistral-large' },
        { id: OTHER_RULE, name: 'Cheap', model: null },
      ] });
      expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      expect(res.text).not.toContain(KEY);
    });

    it('answers 400 when the configured endpoint is not EUrouter', async () => {
      await ctx.saveConfig({ ...BASE, baseUrl: 'https://api.openai.com' });
      const res = await request(app).get('/api/config/eurouter/rules').set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EUrouter is not the configured endpoint');
    });

    it('answers a generic 502 when EUrouter refuses the key; the key is never logged', async () => {
      mockEurouter();
      await ctx.saveConfig({ ...BASE, apiKey: 'eur_wrong' });
      const res = await request(app).get('/api/config/eurouter/rules').set(ADMIN);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Could not load EUrouter routes' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('eur_wrong');
    });
  });

  describe('POST /api/config/eurouter/rules (key typed in the form)', () => {
    it('uses a newly entered key', async () => {
      const fetchSpy = mockEurouter();
      const res = await request(app).post('/api/config/eurouter/rules').set(ADMIN)
        .send({ provider: 'openai', baseUrl: EU, apiKey: 'eur_new_key' });
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(2);
      expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer eur_new_key');
    });

    it('resolves the mask to the stored key for the stored endpoint', async () => {
      const fetchSpy = mockEurouter();
      const res = await request(app).post('/api/config/eurouter/rules').set(ADMIN)
        .send({ provider: 'openai', baseUrl: EU, apiKey: MASKED_SECRET });
      expect(res.status).toBe(200);
      expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    });

    it('is admin-only in guarded mode', async () => {
      mockEurouter();
      const res = await request(app).post('/api/config/eurouter/rules').send({ provider: 'openai', baseUrl: EU, apiKey: 'eur_new_key' });
      expect(res.status).toBe(403);
    });

    it('refuses a non-EUrouter base URL', async () => {
      const res = await request(app).post('/api/config/eurouter/rules').set(ADMIN)
        .send({ provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/config/test on EUrouter', () => {
    it('fails for a wrong key although /models is public', async () => {
      mockEurouter();
      const res = await request(app).post('/api/config/test').set(ADMIN)
        .send({ provider: 'openai', model: 'm', baseUrl: EU, apiKey: 'eur_wrong' });
      expect(res.body).toEqual({ ok: false, error: 'Connection test failed' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('eur_wrong');
    });

    it('passes for the stored key and an existing rule', async () => {
      mockEurouter();
      const res = await request(app).post('/api/config/test').set(ADMIN)
        .send({ provider: 'openai', model: '', baseUrl: EU, apiKey: MASKED_SECRET, ruleId: RULE });
      expect(res.body).toEqual({ ok: true });
    });

    it('fails with a specific message for an unknown rule', async () => {
      mockEurouter();
      const res = await request(app).post('/api/config/test').set(ADMIN)
        .send({ provider: 'openai', model: 'm', baseUrl: EU, apiKey: MASKED_SECRET, ruleId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      expect(res.body).toEqual({ ok: false, error: 'EUrouter routing rule not found or disabled' });
    });

    it('refuses an invalid rule id with 400', async () => {
      const res = await request(app).post('/api/config/test').set(ADMIN)
        .send({ provider: 'openai', model: 'm', baseUrl: EU, apiKey: MASKED_SECRET, ruleId: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid EUrouter rule id');
    });
  });
});
