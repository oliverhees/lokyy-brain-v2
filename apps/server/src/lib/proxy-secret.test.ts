import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { proxySecretGuard, PROXY_SECRET_HEADER, MIN_PROXY_SECRET_LENGTH, readProxySecret } from './proxy-secret';

const SECRET = 's'.repeat(MIN_PROXY_SECRET_LENGTH) + '-vault-anna';

function appWith(secret: string | undefined) {
  const app = express();
  app.use(proxySecretGuard(secret));
  app.get('/api/config', (req, res) => {
    res.json({ ok: true, sawHeader: req.headers[PROXY_SECRET_HEADER] !== undefined });
  });
  app.get('/', (_req, res) => res.send('ui'));
  return app;
}

describe('proxySecretGuard', () => {
  it('passes everything through when no secret is configured (upstream behaviour)', async () => {
    const res = await request(appWith(undefined)).get('/api/config');
    expect(res.status).toBe(200);
  });

  it('rejects requests without the header', async () => {
    const res = await request(appWith(SECRET)).get('/api/config');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('rejects requests with a wrong secret', async () => {
    const res = await request(appWith(SECRET)).get('/api/config').set(PROXY_SECRET_HEADER, SECRET + 'x');
    expect(res.status).toBe(403);
  });

  it('protects non-API paths (web UI) too', async () => {
    const res = await request(appWith(SECRET)).get('/');
    expect(res.status).toBe(403);
  });

  it('accepts the correct secret and strips the header before handlers', async () => {
    const res = await request(appWith(SECRET)).get('/api/config').set(PROXY_SECRET_HEADER, SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sawHeader: false });
  });

  it('rejects a duplicated header even if one value is correct', async () => {
    // Node joins duplicated custom headers into "a, b" before handlers see them.
    const res = await request(appWith(SECRET))
      .get('/api/config')
      .set(PROXY_SECRET_HEADER, `${SECRET}, other`);
    expect(res.status).toBe(403);
  });
});

describe('readProxySecret', () => {
  it('returns undefined when unset or empty', () => {
    expect(readProxySecret({})).toBeUndefined();
    expect(readProxySecret({ VAULT_PROXY_SECRET: '' })).toBeUndefined();
  });

  it('throws when the secret is too short', () => {
    expect(() => readProxySecret({ VAULT_PROXY_SECRET: 'short' })).toThrow(/at least/);
  });

  it('returns a valid secret', () => {
    expect(readProxySecret({ VAULT_PROXY_SECRET: SECRET })).toBe(SECRET);
  });
});
