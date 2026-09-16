// OAuth `state` + PKCE for the Google Drive connect flow (login-CSRF defence).
// There is no session store, so pending states live in memory: 256-bit random,
// single-use, short-lived and bounded in number. A restart invalidates pending
// logins, which only means the user clicks "Connect" again.
import { createHash, randomBytes } from 'node:crypto';

export interface OAuthStart {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface OAuthStateStoreOptions {
  ttlMs?: number;
  maxPending?: number;
  now?: () => number;
}

export class OAuthStateStore {
  private readonly pending = new Map<string, { codeVerifier: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(options: OAuthStateStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxPending = options.maxPending ?? 100;
    this.now = options.now ?? Date.now;
  }

  issue(): OAuthStart {
    this.prune();
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    this.pending.set(state, { codeVerifier, expiresAt: this.now() + this.ttlMs });
    return { state, codeVerifier, codeChallenge };
  }

  /** Returns the PKCE verifier for a valid state and invalidates it; null otherwise. */
  consume(state: unknown): string | null {
    if (typeof state !== 'string' || state.length === 0) return null;
    const entry = this.pending.get(state);
    if (!entry) return null;
    this.pending.delete(state);
    return entry.expiresAt >= this.now() ? entry.codeVerifier : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(state);
    }
  }
}
