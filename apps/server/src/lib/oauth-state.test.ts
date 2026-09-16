import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { OAuthStateStore } from './oauth-state';

describe('OAuthStateStore (LBV2-9, OAuth login CSRF + PKCE)', () => {
  it('issues an unguessable state with an S256 PKCE pair', () => {
    const store = new OAuthStateStore();
    const a = store.issue();
    const b = store.issue();
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.codeChallenge).toBe(createHash('sha256').update(a.codeVerifier).digest('base64url'));
  });

  it('consumes a state exactly once', () => {
    const store = new OAuthStateStore();
    const { state, codeVerifier } = store.issue();
    expect(store.consume(state)).toBe(codeVerifier);
    expect(store.consume(state)).toBeNull();
  });

  it('rejects unknown, missing and non-string states', () => {
    const store = new OAuthStateStore();
    store.issue();
    expect(store.consume('nope')).toBeNull();
    expect(store.consume(undefined)).toBeNull();
    expect(store.consume('')).toBeNull();
    expect(store.consume(['a'])).toBeNull();
  });

  it('expires states after the TTL', () => {
    let now = 1_000;
    const store = new OAuthStateStore({ ttlMs: 600_000, now: () => now });
    const { state } = store.issue();
    now += 600_001;
    expect(store.consume(state)).toBeNull();
  });

  it('bounds the number of pending states (oldest evicted)', () => {
    const store = new OAuthStateStore({ maxPending: 2 });
    const first = store.issue();
    const second = store.issue();
    const third = store.issue();
    expect(store.consume(first.state)).toBeNull();
    expect(store.consume(second.state)).toBe(second.codeVerifier);
    expect(store.consume(third.state)).toBe(third.codeVerifier);
  });
});
