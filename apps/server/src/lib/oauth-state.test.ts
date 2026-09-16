import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { OAuthStateStore } from './oauth-state';

const A = { owner: 'alice', binding: 'alice\nnonce-a' };

describe('OAuthStateStore (LBV2-9, OAuth login CSRF + PKCE)', () => {
  it('issues an unguessable state with an S256 PKCE pair', () => {
    const store = new OAuthStateStore();
    const a = store.issue(A);
    const b = store.issue(A);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.codeChallenge).toBe(createHash('sha256').update(a.codeVerifier).digest('base64url'));
  });

  it('consumes a state exactly once for the same binding', () => {
    const store = new OAuthStateStore();
    const { state, codeVerifier } = store.issue(A);
    expect(store.consume(state, A.binding)).toBe(codeVerifier);
    expect(store.consume(state, A.binding)).toBeNull();
  });

  it('rejects a state presented with a different binding and burns it', () => {
    const store = new OAuthStateStore();
    const { state } = store.issue(A);
    expect(store.consume(state, 'bob\nnonce-a')).toBeNull();
    expect(store.consume(state, 'alice\nother-nonce')).toBeNull();
    expect(store.consume(state, A.binding)).toBeNull();
  });

  it('rejects unknown, missing and non-string states', () => {
    const store = new OAuthStateStore();
    store.issue(A);
    expect(store.consume('nope', A.binding)).toBeNull();
    expect(store.consume(undefined, A.binding)).toBeNull();
    expect(store.consume('', A.binding)).toBeNull();
    expect(store.consume(['a'], A.binding)).toBeNull();
  });

  it('expires states after the TTL', () => {
    let now = 1_000;
    const store = new OAuthStateStore({ ttlMs: 600_000, now: () => now });
    const { state } = store.issue(A);
    now += 600_001;
    expect(store.consume(state, A.binding)).toBeNull();
  });

  it('bounds the number of pending states globally (oldest evicted)', () => {
    const store = new OAuthStateStore({ maxPending: 2, maxPerOwner: 10 });
    const first = store.issue({ owner: 'a', binding: 'a' });
    const second = store.issue({ owner: 'b', binding: 'b' });
    const third = store.issue({ owner: 'c', binding: 'c' });
    expect(store.consume(first.state, 'a')).toBeNull();
    expect(store.consume(second.state, 'b')).toBe(second.codeVerifier);
    expect(store.consume(third.state, 'c')).toBe(third.codeVerifier);
  });

  it('caps pending states per owner (default 3) without evicting other owners', () => {
    const store = new OAuthStateStore();
    const other = store.issue({ owner: 'bob', binding: 'bob' });
    const mine = [1, 2, 3, 4].map(() => store.issue(A));
    expect(store.consume(mine[0]!.state, A.binding)).toBeNull();
    expect(store.consume(mine[3]!.state, A.binding)).toBe(mine[3]!.codeVerifier);
    expect(store.consume(other.state, 'bob')).toBe(other.codeVerifier);
  });
});
