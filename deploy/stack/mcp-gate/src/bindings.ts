// Session bindings: MCP session id → owner (API key hash + endpoint name).
// MetaMCP 2.4.22 keeps sessions in one global table without an owner (finding M2), so the gate
// remembers who initialized each session and rejects every other caller.

export interface BindingOptions {
  idleMs: number;      // unused for longer than this → expired
  lifetimeMs: number;  // older than this → expired, even if active
  max: number;         // map size cap; the oldest binding is evicted first
  now?: () => number;
}

interface Binding { keyHash: string; endpoint: string; created: number; lastSeen: number }

export class Bindings {
  readonly #map = new Map<string, Binding>();
  readonly #opts: BindingOptions;
  readonly #now: () => number;

  constructor(opts: BindingOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number { return this.#map.size; }

  bind(sid: string, keyHash: string, endpoint: string): void {
    if (this.#map.has(sid)) return; // first owner wins; a session id is never re-assigned
    while (this.#map.size >= this.#opts.max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
    const now = this.#now();
    this.#map.set(sid, { keyHash, endpoint, created: now, lastSeen: now });
  }

  check(sid: string, keyHash: string, endpoint: string): boolean {
    const b = this.#map.get(sid);
    if (!b) return false;
    const now = this.#now();
    if (this.#expired(b, now)) { this.#map.delete(sid); return false; }
    if (b.keyHash !== keyHash || b.endpoint !== endpoint) return false;
    b.lastSeen = now;
    return true;
  }

  unbind(sid: string): void { this.#map.delete(sid); }

  sweep(): void {
    const now = this.#now();
    for (const [sid, b] of this.#map) if (this.#expired(b, now)) this.#map.delete(sid);
  }

  #expired(b: Binding, now: number): boolean {
    return now - b.lastSeen > this.#opts.idleMs || now - b.created > this.#opts.lifetimeMs;
  }
}
