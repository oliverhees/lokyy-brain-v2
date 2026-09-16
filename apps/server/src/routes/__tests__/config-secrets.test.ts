import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { configRoutes } from '../config.js';
import {
  MASKED_SECRET, KeyReentryError, maskConfig, maskUrlCredentials, mergeSecrets, unmaskApiKey, resolveStoredBaseUrl,
} from '../../lib/config-secrets.js';
import type { AtlasConfig } from '../../config.js';

const BASE: AtlasConfig = {
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-live-secret-1234', baseUrl: '',
  autoSave: true, mergeSaves: false, maxContextChars: 50000,
  braveApiKey: 'BSA-secret',
  googleTokens: { access_token: 'at', refresh_token: 'rt', expiry: '2030-01-01' },
  googleSyncFolderId: 'folder-1',
  googleSyncFolderName: 'Sync',
  dailyBrief: {
    enabled: false, time: '09:00', timezone: 'UTC', email: 'a@b.c',
    smtp: { host: 'smtp.example', port: 587, secure: false, user: 'u', pass: 'smtp-pass' },
    includeOnThisDay: true, includeQuiz: false, manualOnly: true,
  },
  rss: { enabled: true, intervalMinutes: 60, fetchTimeoutMs: 15000, fetchUserAgent: 'MB', readabilityEnabled: true },
  srs: { enabled: true, autoExtract: true, cardsPerPage: 3, extractionIntervalHours: 6, newCardsPerDayLimit: 20 },
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

  it('maskUrlCredentials hides userinfo and secret-looking query params', () => {
    expect(maskUrlCredentials('https://user:pw@llm.example/v1')).toBe(`https://${MASKED_SECRET}:${MASKED_SECRET}@llm.example/v1`);
    expect(maskUrlCredentials('https://llm.example/v1?key=abc&region=eu')).toBe(`https://llm.example/v1?key=${MASKED_SECRET}&region=eu`);
    expect(maskUrlCredentials('https://llm.example/v1?api_key=a&token=b&access_token=c')).not.toMatch(/=a|=b|=c/);
    expect(maskUrlCredentials('http://localhost:11434')).toBe('http://localhost:11434');
    expect(maskUrlCredentials('')).toBe('');
    expect(maskUrlCredentials('not a url')).toBe('not a url');
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

  it('mergeSecrets refuses to keep the stored key when provider or baseUrl changes (HIGH)', () => {
    const masked = maskConfig(BASE) as unknown as Record<string, unknown>;
    expect(() => mergeSecrets({ ...masked, baseUrl: 'https://attacker.example' }, BASE)).toThrow(KeyReentryError);
    expect(() => mergeSecrets({ ...masked, provider: 'anthropic' }, BASE)).toThrow(KeyReentryError);
    const { apiKey: _k, ...noKey } = masked;
    expect(() => mergeSecrets({ ...noKey, baseUrl: 'https://attacker.example' }, BASE)).toThrow(KeyReentryError);
    // new key with a new endpoint is fine; trailing slash / whitespace is not a change
    expect(mergeSecrets({ ...masked, apiKey: 'sk-new', baseUrl: 'https://attacker.example' }, BASE).apiKey).toBe('sk-new');
    const withUrl = { ...BASE, baseUrl: 'https://llm.example/v1' };
    expect(mergeSecrets({ ...maskConfig(withUrl), baseUrl: ' https://llm.example/v1/ ' } as unknown as Record<string, unknown>, withUrl).apiKey)
      .toBe('sk-live-secret-1234');
    // no stored key → nothing to leak
    expect(mergeSecrets({ baseUrl: 'https://x.example' }, { ...BASE, apiKey: '' }).apiKey).toBe('');
  });

  it('mergeSecrets refuses to keep the SMTP password when the SMTP host changes', () => {
    const masked = maskConfig(BASE);
    const body = { ...masked, dailyBrief: { ...masked.dailyBrief!, smtp: { ...masked.dailyBrief!.smtp, host: 'evil.example' } } };
    expect(() => mergeSecrets(body as unknown as Record<string, unknown>, BASE)).toThrow(KeyReentryError);
  });

  it.each([
    ['port', { port: 2525 }],
    ['secure', { secure: true }],
  ])('mergeSecrets refuses to keep the SMTP password when the SMTP %s changes', (_name, change) => {
    const masked = maskConfig(BASE);
    const body = { ...masked, dailyBrief: { ...masked.dailyBrief!, smtp: { ...masked.dailyBrief!.smtp, ...change } } };
    expect(() => mergeSecrets(body as unknown as Record<string, unknown>, BASE)).toThrow(KeyReentryError);
  });

  it.each([null, 'x', 42, ['a']])('mergeSecrets ignores a non-object %j for dailyBrief/rss/srs (keeps stored)', (bad) => {
    const merged = mergeSecrets({ dailyBrief: bad, rss: bad, srs: bad }, BASE);
    expect(merged.dailyBrief).toEqual(BASE.dailyBrief);
    expect(merged.rss).toEqual(BASE.rss);
    expect(merged.srs).toEqual(BASE.srs);
  });

  it('resolveStoredBaseUrl maps the masked URL back to the stored one', () => {
    const withCreds = { ...BASE, baseUrl: 'https://u:p@llm.example/v1?key=zzz' };
    expect(resolveStoredBaseUrl(maskUrlCredentials(withCreds.baseUrl), withCreds)).toBe(withCreds.baseUrl);
    expect(resolveStoredBaseUrl('https://other.example', withCreds)).toBe('https://other.example');
    expect(resolveStoredBaseUrl(undefined, withCreds)).toBe('');
  });

  it('mergeSecrets restores a masked baseUrl with credentials', () => {
    const withCreds = { ...BASE, baseUrl: 'https://u:p@llm.example/v1?key=zzz' };
    const merged = mergeSecrets(maskConfig(withCreds) as unknown as Record<string, unknown>, withCreds);
    expect(merged.baseUrl).toBe('https://u:p@llm.example/v1?key=zzz');
    expect(merged.apiKey).toBe('sk-live-secret-1234');
  });

  it('mergeSecrets merges a partial body onto the stored config (LOW)', () => {
    const merged = mergeSecrets({ provider: 'openai', model: 'm', apiKey: MASKED_SECRET, baseUrl: '', autoSave: false }, BASE);
    expect(merged.dailyBrief).toEqual(BASE.dailyBrief);
    expect(merged.rss).toEqual(BASE.rss);
    expect(merged.srs).toEqual(BASE.srs);
    expect(merged.googleSyncFolderId).toBe('folder-1');
    expect(merged.googleSyncFolderName).toBe('Sync');
    expect(merged.braveApiKey).toBe('BSA-secret');
    expect(merged.autoSave).toBe(false);
    // known sections merge deeply
    const deep = mergeSecrets({ dailyBrief: { enabled: true } }, BASE);
    expect(deep.dailyBrief?.enabled).toBe(true);
    expect(deep.dailyBrief?.smtp.pass).toBe('smtp-pass');
    expect(mergeSecrets({ srs: { cardsPerPage: 9 } }, BASE).srs?.autoExtract).toBe(true);
  });

  it('mergeSecrets ignores client-sent googleTokens (LOW)', () => {
    const merged = mergeSecrets({ googleTokens: { access_token: 'evil', refresh_token: 'evil', expiry: 'x' } }, BASE);
    expect(merged.googleTokens).toEqual(BASE.googleTokens);
    const none = mergeSecrets({ googleTokens: { access_token: 'evil', refresh_token: 'e', expiry: 'x' } }, { ...BASE, googleTokens: undefined });
    expect(none.googleTokens).toBeUndefined();
  });

  it('unmaskApiKey substitutes the stored key only for the same provider and endpoint', () => {
    expect(unmaskApiKey({ apiKey: MASKED_SECRET, provider: 'openai', baseUrl: '' }, BASE)).toBe('sk-live-secret-1234');
    expect(unmaskApiKey({ apiKey: 'sk-other', provider: 'openai', baseUrl: 'https://x.example' }, BASE)).toBe('sk-other');
    expect(unmaskApiKey({ apiKey: undefined, provider: 'openai', baseUrl: '' }, BASE)).toBe('');
    expect(() => unmaskApiKey({ apiKey: MASKED_SECRET, provider: 'openai', baseUrl: 'https://attacker.example' }, BASE)).toThrow(KeyReentryError);
    expect(() => unmaskApiKey({ apiKey: MASKED_SECRET, provider: 'anthropic', baseUrl: '' }, BASE)).toThrow(KeyReentryError);
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

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); vi.restoreAllMocks(); });

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

  it('PUT without apiKey keeps the stored key and the other sections', async () => {
    await request(app).put('/api/config').send({ provider: 'openai', model: 'm', baseUrl: '', autoSave: true, mergeSaves: false });
    expect(ctx.config.apiKey).toBe('sk-live-secret-1234');
    expect(ctx.config.dailyBrief?.smtp.pass).toBe('smtp-pass');
    expect(ctx.config.rss).toEqual(BASE.rss);
  });

  it('PUT with a new key replaces it', async () => {
    await request(app).put('/api/config').send({ ...maskConfig(BASE), apiKey: 'sk-new-key' });
    expect(ctx.config.apiKey).toBe('sk-new-key');
  });

  it('PUT with the mask and a new baseUrl answers 400 and changes nothing (HIGH)', async () => {
    const res = await request(app).put('/api/config').send({ ...maskConfig(BASE), baseUrl: 'https://attacker.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/re-enter/i);
    expect(ctx.config.baseUrl).toBe('');
  });

  it('POST /test with the mask and a foreign baseUrl answers 400 without calling out (HIGH)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'gpt-4o-mini', apiKey: MASKED_SECRET, baseUrl: 'https://attacker.example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/re-enter/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /test with the masked baseUrl calls the stored endpoint, not the masked string (LOW)', async () => {
    const stored = 'https://u:p@llm.example/v1?key=zzz';
    await ctx.saveConfig({ ...BASE, baseUrl: stored });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'gpt-4o-mini', apiKey: MASKED_SECRET, baseUrl: maskUrlCredentials(stored) });
    expect(res.body).toEqual({ ok: true });
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl.startsWith('https://u:p@llm.example/v1')).toBe(true);
    expect(calledUrl).not.toContain(MASKED_SECRET);
  });

  it('POST /test returns a generic error instead of the upstream message (INFO)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream said: secret internal detail'));
    const res = await request(app).post('/api/config/test')
      .send({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-typed', baseUrl: 'http://127.0.0.1:9' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Connection test failed');
    expect(res.text).not.toContain('secret internal detail');
  });
});
