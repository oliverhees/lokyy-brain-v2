import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { harness, RULE_A, type Harness } from '../../test/fakes/harness.ts';
import { createApp, csrfToken } from './app.ts';
import { AuditLog } from './audit.ts';
import { join } from 'node:path';

const PROXY = 'p'.repeat(40);
const CSRF_SECRET = 'c'.repeat(64);
let h: Harness;
let app: Express;

beforeEach(() => {
  h = harness();
  app = createApp({
    service: h.service, audit: new AuditLog(join(h.dir, 'audit.log')), proxySecret: PROXY, csrfSecret: CSRF_SECRET,
    publicOrigin: 'https://app.example.com', packageName: 'team-10', staticDir: null, log: () => {},
  });
});
afterEach(() => h.cleanup());

type Who = { user: string; groups?: string };
const admin: Who = { user: 'akadmin', groups: 'authentik Admins|lokyy-admins' };
const as = (who: Who, req: request.Test, { csrf = true } = {}) => {
  req.set('x-vault-proxy-secret', PROXY).set('x-authentik-username', who.user);
  if (who.groups !== undefined) req.set('x-authentik-groups', who.groups);
  if (csrf) req.set('x-csrf-token', csrfToken(CSRF_SECRET, who.user));
  return req;
};

describe('perimeter', () => {
  it('healthz answers without credentials and reveals nothing', async () => {
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('rejects requests without or with a wrong proxy secret', async () => {
    expect((await request(app).get('/api/session').set('x-authentik-username', 'akadmin')).status).toBe(403);
    expect((await request(app).get('/api/session').set('x-vault-proxy-secret', 'x'.repeat(40)).set('x-authentik-username', 'akadmin')).status).toBe(403);
  });

  it('rejects requests without identity', async () => {
    expect((await request(app).get('/api/session').set('x-vault-proxy-secret', PROXY)).status).toBe(401);
  });

  it('sets hardening headers and no-store on the API', async () => {
    const r = await as(admin, request(app).get('/api/session'));
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('session', () => {
  it('tells admins apart by the lokyy-admins group and hands out a CSRF token', async () => {
    const r = await as(admin, request(app).get('/api/session'));
    expect(r.body).toMatchObject({ username: 'akadmin', isAdmin: true, csrfToken: csrfToken(CSRF_SECRET, 'akadmin'), hasAccess: false });
    const e = await as({ user: 'anna', groups: 'vault-v01' }, request(app).get('/api/session'));
    expect(e.body.isAdmin).toBe(false);
    expect(r.body.package).toBe('team-10');
    expect(e.body).not.toHaveProperty('package');
  });

  it('a duplicated groups header grants nothing', async () => {
    const r = await as({ user: 'eve', groups: 'vault-v01, lokyy-admins' }, request(app).get('/api/session'));
    expect(r.body.isAdmin).toBe(false);
  });
});

describe('authorization', () => {
  it('employees cannot call admin endpoints', async () => {
    const who = { user: 'anna', groups: 'vault-v01|vault-firma-read' };
    expect((await as(who, request(app).get('/api/admin/users'))).status).toBe(403);
    expect((await as(who, request(app).post('/api/admin/users').send({}))).status).toBe(403);
    expect((await as(who, request(app).get('/api/admin/setup'))).status).toBe(403);
  });
});

describe('CSRF', () => {
  it('rejects mutations without or with a foreign token', async () => {
    const body = { username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader' };
    expect((await as(admin, request(app).post('/api/admin/users').send(body), { csrf: false })).status).toBe(403);
    const r = await as(admin, request(app).post('/api/admin/users').send(body), { csrf: false }).set('x-csrf-token', csrfToken(CSRF_SECRET, 'anna'));
    expect(r.status).toBe(403);
  });

  it('rejects a cross-origin Origin header even with a valid token', async () => {
    const r = await as(admin, request(app).put('/api/admin/setup/company').send({ name: 'X' })).set('origin', 'https://evil.example');
    expect(r.status).toBe(403);
  });

  it('rejects non-JSON bodies', async () => {
    const r = await as(admin, request(app).put('/api/admin/setup/company').set('content-type', 'text/plain').send('name=X'));
    expect(r.status).toBe(415);
  });
});

describe('admin API', () => {
  it('invite → list → role → disable → enable → remove', async () => {
    const inv = await as(admin, request(app).post('/api/admin/users').set('origin', 'https://app.example.com')
      .send({ username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader' }));
    expect(inv.status).toBe(201);
    expect(inv.body.user).toMatchObject({ username: 'anna', slot: 'v01' });
    expect(inv.body.inviteLink).toContain('flow_token=');
    const list = await as(admin, request(app).get('/api/admin/users'));
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0]).not.toHaveProperty('authentikPk');
    expect((await as(admin, request(app).patch('/api/admin/users/anna').send({ role: 'writer' }))).body.user.role).toBe('writer');
    expect((await as(admin, request(app).post('/api/admin/users/anna/disable'))).status).toBe(204);
    expect((await as(admin, request(app).post('/api/admin/users/anna/enable'))).status).toBe(204);
    expect((await as(admin, request(app).delete('/api/admin/users/anna').send({ confirm: 'anna', keepData: true }))).status).toBe(204);
    expect((await as(admin, request(app).get('/api/admin/users'))).body.retired).toHaveLength(1);
    const again = await as(admin, request(app).post('/api/admin/users').send({ username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader', restoreSlot: true }));
    expect(again.body.user.slot).toBe('v01');
    expect((await as(admin, request(app).delete('/api/admin/users/anna').send({ confirm: 'anna', keepData: true }))).status).toBe(204);
    expect((await as(admin, request(app).post('/api/admin/slots/v01/release').send({ confirm: 'v01' }))).status).toBe(204);
    expect((await as(admin, request(app).get('/api/admin/users'))).body.retired).toHaveLength(0);
    expect((await as(admin, request(app).post('/api/admin/slots/..%2F/release').send({ confirm: 'x' }))).status).toBe(404);
  });

  it('maps validation errors to 400 with field codes', async () => {
    const r = await as(admin, request(app).post('/api/admin/users').send({ username: 'A', email: 'x', displayName: '', role: 'x' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'invalid_input', fields: { username: 'length', email: 'format' } });
  });

  it('rejects usernames in the path that are not valid usernames', async () => {
    expect((await as(admin, request(app).post('/api/admin/users/..%2Fx/disable'))).status).toBe(404);
  });

  it('setup endpoints never return secrets', async () => {
    const routes = await as(admin, request(app).post('/api/admin/setup/llm/routes').send({ apiKey: 'sk-eu-abcdefghijkl1234' }));
    expect(routes.body.routes[0]).toEqual(RULE_A);
    await as(admin, request(app).put('/api/admin/setup/llm').send({ mode: 'shared', apiKey: 'sk-eu-abcdefghijkl1234', ruleId: RULE_A.id }));
    await as(admin, request(app).put('/api/admin/setup/smtp').send({ host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'mail-pass-123', from: 'noreply@example.com' }));
    const r = await as(admin, request(app).get('/api/admin/setup'));
    expect(JSON.stringify(r.body)).not.toMatch(/abcdefghijkl|mail-pass-123/);
    expect(r.body.llm.vaults.firma).toEqual({ keyHint: '••••1234', ruleId: RULE_A.id, ruleName: 'eu-standard' });
  });

  it('shows the audit log to admins', async () => {
    await as(admin, request(app).put('/api/admin/setup/company').send({ name: 'Muster GmbH' }));
    const r = await as(admin, request(app).get('/api/admin/audit'));
    expect(r.body.entries[0]).toMatchObject({ actor: 'akadmin', action: 'setup.company' });
  });

  it('never leaks internal error details', async () => {
    h.ak.failNext = { status: 500, body: 'secret internals' };
    const r = await as(admin, request(app).post('/api/admin/users').send({ username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader' }));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('internals');
  });
});

describe('Mein Zugang', () => {
  beforeEach(async () => {
    await h.service.invite('akadmin', { username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'reader' });
  });
  const anna = { user: 'anna', groups: 'vault-v01|vault-firma-read' };

  it('shows the caller their own access', async () => {
    const r = await as(anna, request(app).get('/api/me'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'anna', mcpUrl: 'https://mcp.example.com/metamcp/anna/mcp' });
    expect(r.body).not.toHaveProperty('apiKey');
  });

  it('reveals and regenerates only the own key (POST + CSRF)', async () => {
    expect((await as(anna, request(app).get('/api/me/key'))).status).toBe(404);
    const k1 = (await as(anna, request(app).post('/api/me/key/reveal'))).body.apiKey;
    expect(k1).toMatch(/^sk_mt_/);
    const k2 = (await as(anna, request(app).post('/api/me/key/rotate'))).body.apiKey;
    expect(k2).not.toBe(k1);
    expect((await as(anna, request(app).post('/api/me/key/reveal'), { csrf: false })).status).toBe(403);
  });

  it('GET /api/me has no side effects; activation is an explicit POST with CSRF', async () => {
    await as(anna, request(app).get('/api/me'));
    expect((await h.service.listUsers()).users[0]!.status).toBe('invited');
    expect((await as(anna, request(app).post('/api/me/activate'), { csrf: false })).status).toBe(403);
    expect((await as(anna, request(app).post('/api/me/activate'))).status).toBe(204);
    expect((await h.service.listUsers()).users[0]!.status).toBe('active');
  });

  it('users without a slot get 404 no_access', async () => {
    const r = await as({ user: 'stranger', groups: '' }, request(app).get('/api/me'));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_access');
  });

  it('rate-limits key reveals per user', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await as(anna, request(app).post('/api/me/key/reveal'))).status;
    expect(last).toBe(429);
  });
});
