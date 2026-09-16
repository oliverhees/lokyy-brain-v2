import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { configRoutes } from '../config.js';
import { MASKED_SECRET, maskConfig, mergeSecrets, unmaskApiKey } from '../../lib/config-secrets.js';
import type { AtlasConfig } from '../../config.js';

const BASE: AtlasConfig = {
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-live-secret-1234', baseUrl: '',
  autoSave: true, mergeSaves: false, maxContextChars: 50000,
  braveApiKey: 'BSA-secret',
  googleTokens: { access_token: 'at', refresh_token: 'rt', expiry: '2030-01-01' },
  dailyBrief: {
    enabled: false, time: '09:00', timezone: 'UTC', email: 'a@b.c',
    smtp: { host: 'smtp', port: 587, secure: false, user: 'u', pass: 'smtp-pass' },
    includeOnThisDay: true, includeQuiz: false, manualOnly: true,
  },
};

describe('config-secrets helpers (LBV2-9)', () => {
  it('maskConfig masks every secret and reports presence', () => {
    const m = maskConfig(BASE);
    expect(m.apiKey).toBe(MASKED_SECRET);
    expect(m.hasApiKey).toBe(true);
    expect(m.braveApiKey).toBe(MASKED_SECRET);
    expect(m.dailyBrief?.smtp.pass).toBe(MASKED_SECRET);
    expect(m).not.toHaveProperty('googleTokens');
    expect(JSON.stringify(m)).not.toMatch(/sk-live|BSA-secret|smtp-pass|"rt"/);
    expect(BASE.apiKey).toBe('sk-live-secret-1234'); // input not mutated
  });

  it('maskConfig leaves empty secrets empty', () => {
    const m = maskConfig({ ...BASE, apiKey: '', braveApiKey: undefined });
    expect(m.apiKey).toBe('');
    expect(m.hasApiKey).toBe(false);
    expect(m.braveApiKey).toBeUndefined();
  });

  it('mergeSecrets keeps stored secrets when masked or omitted, replaces on a new value', () => {
    const incoming = { ...maskConfig(BASE), model: 'gpt-5' } as Record<string, unknown>;
    const merged = mergeSecrets(incoming, BASE);
    expect(merged.apiKey).toBe('sk-live-secret-1234');
    expect(merged.braveApiKey).toBe('BSA-secret');
    expect(merged.dailyBrief?.smtp.pass).toBe('smtp-pass');
    expect(merged.googleTokens).toEqual(BASE.googleTokens);
    expect(merged.model).toBe('gpt-5');
    expect(merged).not.toHaveProperty('hasApiKey');

    const { apiKey: _omit, ...withoutKey } = incoming;
    expect(mergeSecrets(withoutKey, BASE).apiKey).toBe('sk-live-secret-1234');
    expect(mergeSecrets({ ...incoming, apiKey: 'sk-new' }, BASE).apiKey).toBe('sk-new');
    expect(mergeSecrets({ ...incoming, apiKey: '' }, BASE).apiKey).toBe('');
  });

  it('unmaskApiKey substitutes the stored key only for the mask', () => {
    expect(unmaskApiKey(MASKED_SECRET, BASE)).toBe('sk-live-secret-1234');
    expect(unmaskApiKey('sk-other', BASE)).toBe('sk-other');
    expect(unmaskApiKey(undefined, BASE)).toBe('');
  });
});

describe('/api/config routes — secret masking (LBV2-9)', () => {
  let outer: string;
  let dataDir: string;
  let ctx: ServerContext;
  let app: express.Application;

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'config-secrets-test-'));
    dataDir = join(outer, 'data');
    await mkdir(dataDir, { recursive: true });
    ctx = await createContext(dataDir);
    await ctx.saveConfig({ ...BASE });
    app = express();
    app.use(express.json());
    app.use('/api/config', configRoutes(ctx));
  });

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); });

  it('GET never returns the stored API key', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe(MASKED_SECRET);
    expect(res.body.hasApiKey).toBe(true);
    expect(res.text).not.toContain('sk-live-secret-1234');
    expect(res.text).not.toContain('smtp-pass');
  });

  it('PUT with the masked value (round trip of GET) keeps the stored key', async () => {
    const got = await request(app).get('/api/config');
    const res = await request(app).put('/api/config').send({ ...got.body, model: 'gpt-5' });
    expect(res.status).toBe(200);
    expect(ctx.config.apiKey).toBe('sk-live-secret-1234');
    expect(ctx.config.model).toBe('gpt-5');
    const onDisk = JSON.parse(await readFile(join(dataDir, 'mindbase.config.json'), 'utf-8')) as AtlasConfig & { hasApiKey?: boolean };
    expect(onDisk.apiKey).toBe('sk-live-secret-1234');
    expect(onDisk.hasApiKey).toBeUndefined();
    expect(onDisk.googleTokens).toEqual(BASE.googleTokens);
  });

  it('PUT without apiKey keeps the stored key', async () => {
    await request(app).put('/api/config').send({ provider: 'openai', model: 'm', baseUrl: '', autoSave: true, mergeSaves: false });
    expect(ctx.config.apiKey).toBe('sk-live-secret-1234');
  });

  it('PUT with a new key replaces it', async () => {
    await request(app).put('/api/config').send({ ...maskConfig(BASE), apiKey: 'sk-new-key' });
    expect(ctx.config.apiKey).toBe('sk-new-key');
  });
});
