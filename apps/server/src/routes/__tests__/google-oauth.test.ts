import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, type ServerContext } from '../../context.js';
import { googleRoutes, type GoogleOAuthDeps } from '../google.js';
import { OAuthStateStore } from '../../lib/oauth-state.js';

const TOKENS = { access_token: 'at', refresh_token: 'rt', expiry: '2030-01-01T00:00:00.000Z' };

describe('Google OAuth callback — state + PKCE (LBV2-9)', () => {
  let outer: string;
  let ctx: ServerContext;
  let app: express.Application;
  let deps: GoogleOAuthDeps & { exchangeCode: ReturnType<typeof vi.fn>; getAuthUrl: ReturnType<typeof vi.fn> };

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
    app = express();
    app.use('/api/google', googleRoutes(ctx, deps));
  });

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); });

  async function startState(path: '/api/google/auth/start' | '/api/google/auth/url'): Promise<string> {
    const res = await request(app).get(path);
    const url = path.endsWith('start') ? res.headers['location'] as string : (res.body as { url: string }).url;
    const state = new URL(url).searchParams.get('state');
    expect(state).toBeTruthy();
    return state!;
  }

  it('/auth/start and /auth/url put a fresh state and S256 challenge into the auth URL', async () => {
    const s1 = await startState('/api/google/auth/start');
    const s2 = await startState('/api/google/auth/url');
    expect(s1).not.toBe(s2);
    const arg = deps.getAuthUrl.mock.calls[0]![0] as { codeChallenge: string };
    expect(arg.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a callback without state and does not exchange the code', async () => {
    const res = await request(app).get('/api/google/auth/callback?code=attacker');
    expect(res.status).toBe(400);
    expect(deps.exchangeCode).not.toHaveBeenCalled();
    expect(ctx.config.googleTokens).toBeUndefined();
  });

  it('rejects a callback with an unknown state', async () => {
    await startState('/api/google/auth/start');
    const res = await request(app).get('/api/google/auth/callback?code=attacker&state=forged');
    expect(res.status).toBe(400);
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it('accepts a valid state once, passing the PKCE verifier to the exchange', async () => {
    const state = await startState('/api/google/auth/start');
    const ok = await request(app).get(`/api/google/auth/callback?code=good&state=${state}`);
    expect(ok.status).toBe(302);
    expect(deps.exchangeCode).toHaveBeenCalledTimes(1);
    const [code, verifier] = deps.exchangeCode.mock.calls[0]! as [string, string];
    expect(code).toBe('good');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(ctx.config.googleTokens).toEqual(TOKENS);

    const replay = await request(app).get(`/api/google/auth/callback?code=good&state=${state}`);
    expect(replay.status).toBe(400);
    expect(deps.exchangeCode).toHaveBeenCalledTimes(1);
  });
});
