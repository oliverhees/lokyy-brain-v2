import { describe, it, expect } from 'vitest';
import { isValidUsername } from '@mindbase/core';
import { resolveUser, rejectInvalidUser, InvalidUserError, UNKNOWN_USER, sanitizeUsername } from '../user-attribution.js';

describe('resolveUser — trusted proxy identity (LBV2-9)', () => {
  const guarded = { VAULT_PROXY_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv;

  it('uses x-authentik-username by default when the proxy guard is active', () => {
    expect(resolveUser({ headers: { 'x-authentik-username': 'bob' } }, { env: guarded })).toBe('bob');
  });

  it('ignores a client-sent x-mindbase-user when the proxy guard is active', () => {
    const req = { headers: { 'x-mindbase-user': 'ceo', 'x-authentik-username': 'bob' } };
    expect(resolveUser(req, { env: guarded })).toBe('bob');
  });

  it('does not reject an invalid x-mindbase-user in guarded mode (the header is ignored)', () => {
    const req = { headers: { 'x-mindbase-user': '../../evil', 'x-authentik-username': 'bob' } };
    expect(resolveUser(req, { env: guarded })).toBe('bob');
  });

  it('honours VAULT_IDENTITY_HEADER (trimmed, case-insensitive)', () => {
    const env = { ...guarded, VAULT_IDENTITY_HEADER: ' X-Forwarded-User ' } as NodeJS.ProcessEnv;
    const req = { headers: { 'x-forwarded-user': 'carol', 'x-authentik-username': 'mallory' } };
    expect(resolveUser(req, { env })).toBe('carol');
  });

  it('falls back to the fixed user "unknown" when the identity header is missing or empty', () => {
    expect(UNKNOWN_USER).toBe('unknown');
    expect(resolveUser({ headers: { 'x-mindbase-user': 'ceo' } }, { env: guarded })).toBe('unknown');
    expect(resolveUser({ headers: { 'x-authentik-username': '' } }, { env: guarded })).toBe('unknown');
  });

  it.each(['alice@example.com', '../x', 'a b'])('throws InvalidUserError for an invalid identity %j', (value) => {
    expect(() => resolveUser({ headers: { 'x-authentik-username': value } }, { env: guarded })).toThrow(InvalidUserError);
  });

  it('rejects a duplicated identity header (array value)', () => {
    const req = { headers: { 'x-authentik-username': ['bob', 'eve'] } };
    expect(() => resolveUser(req, { env: guarded })).toThrow(InvalidUserError);
  });

  it('keeps the x-mindbase-user behaviour when the guard is not active', () => {
    const req = { headers: { 'x-mindbase-user': 'alice', 'x-authentik-username': 'bob' } };
    expect(resolveUser(req, { env: {} })).toBe('alice');
  });

  it('middleware passes an invalid x-mindbase-user through in guarded mode', () => {
    const prev = process.env['VAULT_PROXY_SECRET'];
    process.env['VAULT_PROXY_SECRET'] = 'x'.repeat(32);
    try {
      let nextCalled = false;
      const res = { status() { return this; }, json() { return this; } };
      rejectInvalidUser({ headers: { 'x-mindbase-user': '../x', 'x-authentik-username': 'bob' } } as never, res as never, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['VAULT_PROXY_SECRET'];
      else process.env['VAULT_PROXY_SECRET'] = prev;
    }
  });
});

describe('resolveUser — OS username fallback (LBV2-14)', () => {
  it.each([
    ['oliver@corp.example', 'oliver_corp.example'],
    ['John Smith', 'John_Smith'],
    ['.hidden', 'hidden'],
    ['-dash', 'dash'],
    ['a..b', 'a.b'],
    ['', 'user'],
    ['...', 'user'],
    ['ok_name', 'ok_name'],
  ])('maps %j to the valid username %j', (osName, expected) => {
    const u = resolveUser({ headers: {} }, { env: {}, osUsername: () => osName });
    expect(u).toBe(expected);
    expect(isValidUsername(u)).toBe(true);
  });

  it('truncates long OS usernames to a valid length', () => {
    const u = resolveUser({ headers: {} }, { env: {}, osUsername: () => 'x'.repeat(100) });
    expect(isValidUsername(u)).toBe(true);
    expect(u).toBe(sanitizeUsername('x'.repeat(100)));
  });

  it('falls back to "user" when the OS lookup throws', () => {
    expect(resolveUser({ headers: {} }, { env: {}, osUsername: () => { throw new Error('no passwd entry'); } })).toBe('user');
  });

  it('still throws for an invalid explicit header', () => {
    expect(() => resolveUser({ headers: { 'x-mindbase-user': 'a b' } }, { env: {}, osUsername: () => 'x y' }))
      .toThrow(InvalidUserError);
  });
});

describe('resolveUser', () => {
  it('returns header value if provided', () => {
    const req = { headers: { 'x-mindbase-user': 'alice' } };
    expect(resolveUser(req)).toBe('alice');
  });
  it('falls back to os.userInfo when header absent', () => {
    const req = { headers: {} };
    const u = resolveUser(req);
    expect(typeof u).toBe('string');
    expect(u.length).toBeGreaterThan(0);
  });
  it('ignores empty header', () => {
    const req = { headers: { 'x-mindbase-user': '' } };
    const u = resolveUser(req);
    expect(u).not.toBe('');
  });
  it.each(['../../../../tmp', '..', '.', 'a/b', 'a\\b', 'x'.repeat(65)])('throws InvalidUserError for %j', (value) => {
    const req = { headers: { 'x-mindbase-user': value } };
    expect(() => resolveUser(req)).toThrow(InvalidUserError);
  });
});

describe('rejectInvalidUser middleware', () => {
  function run(headers: Record<string, string>): { status?: number; body?: unknown; nextCalled: boolean } {
    const out: { status?: number; body?: unknown; nextCalled: boolean } = { nextCalled: false };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body; return this; },
    };
    rejectInvalidUser({ headers } as never, res as never, () => { out.nextCalled = true; });
    return out;
  }

  it('passes valid and absent headers through', () => {
    expect(run({ 'x-mindbase-user': 'alice' }).nextCalled).toBe(true);
    expect(run({}).nextCalled).toBe(true);
  });

  it('answers 400 for an invalid header', () => {
    const out = run({ 'x-mindbase-user': '../../etc' });
    expect(out).toEqual({ status: 400, body: { error: 'Invalid X-Mindbase-User header' }, nextCalled: false });
  });
});
