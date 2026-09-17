import { describe, it, expect } from 'vitest';
import { USERNAME_RULES_ERROR, resolveContributorUsername, sanitizeUsername } from './safe-names';

// LBV2-14 QA: MCP mindbase_contribute derived the contributor from the raw OS account.
describe('resolveContributorUsername', () => {
  it('validates an explicit user strictly (no sanitizing)', () => {
    expect(resolveContributorUsername({ explicit: 'alice', allowOsFallback: true, osUsername: () => 'x' })).toEqual({ ok: true, user: 'alice' });
    for (const bad of ['jürgen', 'unknown', '../x', 'a b']) {
      expect(resolveContributorUsername({ explicit: bad, allowOsFallback: true, osUsername: () => 'x' }))
        .toEqual({ ok: false, error: USERNAME_RULES_ERROR });
    }
  });

  it.each([
    ['jürgen', 'j_rgen'], ['oliver@corp', 'oliver_corp'], ['名前', 'user'], ['unknown', 'user'], ['ok', 'ok'],
  ])('sanitizes the OS account %j to %j when the fallback is allowed', (os, expected) => {
    expect(resolveContributorUsername({ allowOsFallback: true, osUsername: () => os })).toEqual({ ok: true, user: expected });
  });

  it('uses "user" when the OS lookup throws', () => {
    expect(resolveContributorUsername({ allowOsFallback: true, osUsername: () => { throw new Error('no passwd'); } }))
      .toEqual({ ok: true, user: 'user' });
  });

  it('requires an explicit user when the OS fallback is not allowed (remote transport)', () => {
    expect(resolveContributorUsername({ allowOsFallback: false, osUsername: () => 'server-account' }).ok).toBe(false);
  });

  it('error text names the ASCII alphabet and the reserved name', () => {
    expect(USERNAME_RULES_ERROR).toMatch(/ASCII/);
    expect(USERNAME_RULES_ERROR).toMatch(/unknown/);
  });

  it('sanitizeUsername maps onto the username alphabet', () => {
    expect(sanitizeUsername('John Smith')).toBe('John_Smith');
    expect(sanitizeUsername('...')).toBe('user');
  });
});
