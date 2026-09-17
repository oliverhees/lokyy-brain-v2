import { describe, it, expect } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { isCaptureDisabled, captureGate, serverFeatures, healthPayload, shouldStartCaptureWorker, shouldStartMdns } from './capture-gate';

function appWith(env: NodeJS.ProcessEnv): express.Application {
  const app = express();
  const ok = Router();
  ok.all('*', (_req, res) => { res.json({ reached: true }); });
  app.use('/api/capture', captureGate(env), ok);
  app.use('/api/devices', captureGate(env), ok);
  app.use('/api/inbox', ok);
  return app;
}

describe('capture gate (LBV2-9, MINDBASE_DISABLE_CAPTURE)', () => {
  it.each([['1', true], ['true', true], [' TRUE ', true], ['yes', true], ['0', false], ['', false], [undefined, false], ['off', false]])(
    'isCaptureDisabled(%j) === %j', (value, expected) => {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { MINDBASE_DISABLE_CAPTURE: value };
      expect(isCaptureDisabled(env)).toBe(expected);
    },
  );

  it('answers 404 for capture and device pairing routes when disabled', async () => {
    const app = appWith({ MINDBASE_DISABLE_CAPTURE: '1' });
    for (const [method, path] of [
      ['post', '/api/capture'], ['get', '/api/devices'], ['get', '/api/devices/pair-code'], ['post', '/api/devices/pair'],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
  });

  it('leaves the inbox reachable when disabled (RSS uses it)', async () => {
    const res = await request(appWith({ MINDBASE_DISABLE_CAPTURE: '1' })).get('/api/inbox');
    expect(res.status).toBe(200);
  });

  it('passes through when enabled', async () => {
    const res = await request(appWith({})).get('/api/devices/pair-code');
    expect(res.body).toEqual({ reached: true });
  });

  it('reports the feature state for the web UI', () => {
    expect(serverFeatures({ MINDBASE_DISABLE_CAPTURE: '1' })).toEqual({ capture: false, localModels: true });
    expect(serverFeatures({})).toEqual({ capture: true, localModels: true });
  });

  it('reports local models (Ollama onboarding) as unavailable in guarded mode (LBV2-19)', () => {
    expect(serverFeatures({ VAULT_PROXY_SECRET: 'x'.repeat(32) }).localModels).toBe(false);
    expect(serverFeatures({ VAULT_REQUIRE_PROXY_SECRET: '1' }).localModels).toBe(false);
  });

  it('health payload does not disclose the data directory (INFO)', () => {
    expect(healthPayload({ MINDBASE_DISABLE_CAPTURE: '1' })).toEqual({ ok: true, features: { capture: false, localModels: true } });
  });

  it('does not start the capture worker or mDNS when disabled', () => {
    expect(shouldStartCaptureWorker({ MINDBASE_DISABLE_CAPTURE: '1' })).toBe(false);
    expect(shouldStartCaptureWorker({})).toBe(true);
    expect(shouldStartMdns({ MINDBASE_DISABLE_CAPTURE: '1' })).toBe(false);
    expect(shouldStartMdns({ MINDBASE_MDNS: 'off' })).toBe(false);
    expect(shouldStartMdns({})).toBe(true);
  });
});
