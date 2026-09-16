import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { googleRoutes, type GoogleOAuthDeps, OAUTH_COOKIE } from '../google.js';
import { OAuthStateStore } from '../../lib/oauth-state.js';

const TOKENS = { access_token: 'at', refresh_token: 'rt', expiry: '2030-01-01T00:00:00.000Z' };
const GUARDED: NodeJS.ProcessEnv = { VAULT_PROXY_SECRET: 'x'.repeat(32), VAULT_ADMIN_GROUPS: 'admins' };

type Fn = ReturnType<typeof vi.fn>;

describe('Google OAuth — admin gate, state bound to initiator, PKCE (LBV2-9)', () => {
  let outer: string;
  let ctx: ServerContext;
  let deps: GoogleOAuthDeps & { exchangeCode: Fn; getAuthUrl: Fn };

  function appFor(env: NodeJS.ProcessEnv): express.Application {
    const app = express();
    app.use('/api/google', googleRoutes(ctx, { ...deps, env }));
    return app;
  }

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'google-oauth-test-'));
    const dataDir = join(outer, 'data');
    await mkdir(dataDir, { recursive: true });
    ctx = await createContext(dataDir);
    deps = {
      stateStore: new OAuthStateStore(),
      getAuthUrl: vi.fn((p: { state: string; codeChallenge: string }) => `https://accounts.example/auth?state=${p.state}&code_challenge=${p.codeChallenge}`),
      exchangeCode: vi.fn(async () => TOKENS),
    };
  });

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); });

  interface Started { state: string; cookie: string }

  async function start(app: express.Application, path: string, headers: Record<string, string> = {}): Promise<Started> {
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBeLessThan(400);
    const url = path.endsWith('start') ? res.headers['location'] as string : (res.body as { url: string }).url;
    const state = new URL(url).searchParams.get('state');
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const raw = setCookie.find((c) => c.startsWith(`${OAUTH_COOKIE}=`));
    expect(state).toBeTruthy();
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    return { state: state!, cookie: raw!.split(';')[0]! };
  }

  describe('local mode (cookie binding)', () => {
    it('/auth/start and /auth/url put a fresh state and S256 challenge into the auth URL', async () => {
      const app = appFor({});
      const s1 = await start(app, '/api/google/auth/start');
      const s2 = await start(app, '/api/google/auth/url');
      expect(s1.state).not.toBe(s2.state);
      const arg = deps.getAuthUrl.mock.calls[0]![0] as { codeChallenge: string };
      expect(arg.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('rejects a callback without state and does not exchange the code', async () => {
      const res = await request(appFor({})).get('/api/google/auth/callback?code=attacker');
      expect(res.status).toBe(400);
      expect(deps.exchangeCode).not.toHaveBeenCalled();
      expect(ctx.config.googleTokens).toBeUndefined();
    });

    it('rejects a valid state presented without the initiating browser cookie', async () => {
      const app = appFor({});
      const { state } = await start(app, '/api/google/auth/start');
      const res = await request(app).get(`/api/google/auth/callback?code=c&state=${state}`);
      expect(res.status).toBe(400);
      expect(deps.exchangeCode).not.toHaveBeenCalled();
    });

    it('rejects a valid state presented with another browser cookie', async () => {
      const app = appFor({});
      const { state } = await start(app, '/api/google/auth/start');
      const other = await start(app, '/api/google/auth/start');
      const res = await request(app).get(`/api/google/auth/callback?code=c&state=${state}`).set('Cookie', other.cookie.replace(/=.*/, '=forged'));
      expect(res.status).toBe(400);
      expect(deps.exchangeCode).not.toHaveBeenCalled();
    });

    it('accepts the state once from the initiating browser, passing the PKCE verifier', async () => {
      const app = appFor({});
      const { state, cookie } = await start(app, '/api/google/auth/start');
      const ok = await request(app).get(`/api/google/auth/callback?code=good&state=${state}`).set('Cookie', cookie);
      expect(ok.status).toBe(302);
      const [code, verifier] = deps.exchangeCode.mock.calls[0]! as [string, string];
      expect(code).toBe('good');
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(ctx.config.googleTokens).toEqual(TOKENS);
      const replay = await request(app).get(`/api/google/auth/callback?code=good&state=${state}`).set('Cookie', cookie);
      expect(replay.status).toBe(400);
      expect(deps.exchangeCode).toHaveBeenCalledTimes(1);
    });
  });

  describe('guarded mode (admin gate + identity binding)', () => {
    const adminA = { 'x-authentik-username': 'anna', 'x-authentik-groups': 'admins' };
    const adminB = { 'x-authentik-username': 'bert', 'x-authentik-groups': 'staff|admins' };
    const writer = { 'x-authentik-username': 'will', 'x-authentik-groups': 'staff' };

    it.each(['/api/google/auth/url', '/api/google/auth/start', '/api/google/auth/callback?code=c&state=s'])(
      'a non-admin gets 403 on %s', async (path) => {
        const res = await request(appFor(GUARDED)).get(path).set(writer);
        expect(res.status).toBe(403);
        expect(deps.getAuthUrl).not.toHaveBeenCalled();
        expect(deps.exchangeCode).not.toHaveBeenCalled();
      },
    );

    it('a state issued to admin A cannot be completed by admin B, even with A\'s cookie', async () => {
      const app = appFor(GUARDED);
      const { state, cookie } = await start(app, '/api/google/auth/url', adminA);
      const res = await request(app).get(`/api/google/auth/callback?code=c&state=${state}`).set(adminB).set('Cookie', cookie);
      expect(res.status).toBe(400);
      expect(deps.exchangeCode).not.toHaveBeenCalled();
      expect(ctx.config.googleTokens).toBeUndefined();
    });

    it('the same admin completes the flow', async () => {
      const app = appFor(GUARDED);
      const { state, cookie } = await start(app, '/api/google/auth/start', adminA);
      const res = await request(app).get(`/api/google/auth/callback?code=c&state=${state}`).set(adminA).set('Cookie', cookie);
      expect(res.status).toBe(302);
      expect(ctx.config.googleTokens).toEqual(TOKENS);
    });

    it('an admin without an identity header cannot start the flow', async () => {
      const res = await request(appFor(GUARDED)).get('/api/google/auth/url').set({ 'x-authentik-groups': 'admins' });
      expect(res.status).toBe(401);
      expect(deps.getAuthUrl).not.toHaveBeenCalled();
    });
  });
});
