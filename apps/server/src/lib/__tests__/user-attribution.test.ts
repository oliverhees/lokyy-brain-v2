import { describe, it, expect } from 'vitest';
import { resolveUser, rejectInvalidUser, InvalidUserError } from '../user-attribution.js';

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
