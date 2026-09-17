// Session bindings: MCP session id → owner (API key hash + endpoint name).
// MetaMCP 2.4.22 keeps sessions in one global table without an owner (finding M2), so the gate
// remembers who initialized each session and rejects every other caller.

export interface BindingOptions {
  idleMs: number;      // unused for longer than this → expired
  lifetimeMs: number;  // older than this → expired, even if active
  max: number;         // global cap: when reached, NEW keys are refused (fail closed), nobody is evicted
  maxPerKey: number;   // per API key: a key over its cap loses its own oldest binding, never another key's
  now?: () => number;
}

interface Binding { keyHash: string; endpoint: string; created: number; lastSeen: number }

export class Bindings {
  readonly #map = new Map<string, Binding>();
  readonly #perKey = new Map<string, string[]>(); // keyHash → session ids, oldest first
  readonly #opts: BindingOptions;
  readonly #now: () => number;

  constructor(opts: BindingOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number { return this.#map.size; }

  /** True if a new binding for this key would be accepted (after sweeping expired entries). */
  hasCapacity(keyHash: string): boolean {
    if (this.#map.size < this.#opts.max) return true;
    this.sweep();
    if (this.#map.size < this.#opts.max) return true;
    // Full: only a key that already holds bindings may continue, by replacing its own oldest one.
    return (this.#perKey.get(keyHash)?.length ?? 0) > 0;
  }

  /** Returns false (and binds nothing) when the gate is full for this key. */
  bind(sid: string, keyHash: string, endpoint: string): boolean {
    if (this.#map.has(sid)) return this.#map.get(sid)!.keyHash === keyHash; // first owner wins
    if (!this.hasCapacity(keyHash)) return false;
    const own = this.#perKey.get(keyHash) ?? [];
    while (own.length >= this.#opts.maxPerKey || (this.#map.size >= this.#opts.max && own.length > 0)) {
      const oldest = own.shift();
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
    const now = this.#now();
    this.#map.set(sid, { keyHash, endpoint, created: now, lastSeen: now });
    own.push(sid);
    this.#perKey.set(keyHash, own);
    return true;
  }

  check(sid: string, keyHash: string, endpoint: string): boolean {
    const b = this.#map.get(sid);
    if (!b) return false;
    const now = this.#now();
    if (this.#expired(b, now)) { this.#remove(sid, b); return false; }
    if (b.keyHash !== keyHash || b.endpoint !== endpoint) return false;
    b.lastSeen = now;
    return true;
  }

  unbind(sid: string): void {
    const b = this.#map.get(sid);
    if (b) this.#remove(sid, b);
  }

  sweep(): void {
    const now = this.#now();
    for (const [sid, b] of this.#map) if (this.#expired(b, now)) this.#remove(sid, b);
  }

  #remove(sid: string, b: Binding): void {
    this.#map.delete(sid);
    const own = this.#perKey.get(b.keyHash);
    if (!own) return;
    const rest = own.filter((s) => s !== sid);
    if (rest.length) this.#perKey.set(b.keyHash, rest); else this.#perKey.delete(b.keyHash);
  }

  #expired(b: Binding, now: number): boolean {
    return now - b.lastSeen > this.#opts.idleMs || now - b.created > this.#opts.lifetimeMs;
  }
}
