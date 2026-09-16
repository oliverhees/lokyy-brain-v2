// OAuth `state` + PKCE for the Google Drive connect flow (login-CSRF defence).
// There is no session store, so pending states live in memory: 256-bit random,
// single-use, short-lived and bounded (globally and per owner). Each state is
// bound to its initiator (proxy identity and/or a browser cookie nonce); the
// callback must present the same binding, so a callback URL handed to someone
// else is useless. A restart invalidates pending logins.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthStart {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface OAuthStateStoreOptions {
  ttlMs?: number;
  maxPending?: number;
  maxPerOwner?: number;
  now?: () => number;
}

export interface OAuthInitiator {
  /** Whose quota the state counts against (identity, or cookie nonce locally). */
  owner: string;
  /** Secret-ish binding the callback must reproduce exactly. */
  binding: string;
}

interface Pending {
  codeVerifier: string;
  expiresAt: number;
  owner: string;
  bindingHash: Buffer;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class OAuthStateStore {
  private readonly pending = new Map<string, Pending>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly maxPerOwner: number;
  private readonly now: () => number;

  constructor(options: OAuthStateStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxPending = options.maxPending ?? 100;
    this.maxPerOwner = options.maxPerOwner ?? 3;
    this.now = options.now ?? Date.now;
  }

  issue(initiator: OAuthInitiator): OAuthStart {
    this.prune();
    const own = [...this.pending].filter(([, p]) => p.owner === initiator.owner).map(([s]) => s);
    while (own.length >= this.maxPerOwner) this.pending.delete(own.shift()!);
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    this.pending.set(state, {
      codeVerifier,
      expiresAt: this.now() + this.ttlMs,
      owner: initiator.owner,
      bindingHash: hash(initiator.binding),
    });
    return { state, codeVerifier, codeChallenge };
  }

  /**
   * Returns the PKCE verifier when the state exists, is unexpired and was
   * issued to the same binding; null otherwise. The state is invalidated on
   * any lookup (a mismatched attempt burns it).
   */
  consume(state: unknown, binding: string): string | null {
    if (typeof state !== 'string' || state.length === 0) return null;
    const entry = this.pending.get(state);
    if (!entry) return null;
    this.pending.delete(state);
    if (entry.expiresAt < this.now()) return null;
    return timingSafeEqual(entry.bindingHash, hash(binding)) ? entry.codeVerifier : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(state);
    }
  }
}
