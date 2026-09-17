// Session bindings: MCP session id → owner (API key hash + endpoint name).
// MetaMCP 2.4.22 keeps sessions in one global table without an owner (finding M2), so the gate
// remembers who initialized each session and rejects every other caller.

export type RemoveReason = 'evicted' | 'expired' | 'unbound';

export interface BindingOptions {
  idleMs: number;      // unused for longer than this → expired
  lifetimeMs: number;  // older than this → expired, even if active
  max: number;         // global cap: when reached, NEW keys are refused (fail closed), nobody is evicted
  maxPerKey: number;   // per API key: a key over its cap loses its own oldest binding, never another key's
  now?: () => number;
  /** Called once for every binding that leaves the table (with the key that created it). */
  onRemove?: (sid: string, owner: { key: string; keyHash: string; endpoint: string }, reason: RemoveReason) => void;
}

interface Binding { keyHash: string; key: string; endpoint: string; created: number; lastSeen: number }

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
  get max(): number { return this.#opts.max; }

  /** True if a new binding for this key would be accepted (after sweeping expired entries). */
  hasCapacity(keyHash: string): boolean {
    if (this.#map.size < this.#opts.max) return true;
    this.sweep();
    if (this.#map.size < this.#opts.max) return true;
    // Full: only a key that already holds bindings may continue, by replacing its own oldest one.
    return (this.#perKey.get(keyHash)?.length ?? 0) > 0;
  }

  /** Returns false (and binds nothing) when the gate is full for this key. */
  bind(sid: string, keyHash: string, endpoint: string, key = ''): boolean {
    if (this.#map.has(sid)) return this.#map.get(sid)!.keyHash === keyHash; // first owner wins
    if (!this.hasCapacity(keyHash)) return false;
    for (;;) {
      const own = this.#perKey.get(keyHash) ?? []; // re-read: #remove replaces the list
      if (!(own.length >= this.#opts.maxPerKey || (this.#map.size >= this.#opts.max && own.length > 0))) break;
      this.#remove(own[0] as string, 'evicted');
    }
    const now = this.#now();
    this.#map.set(sid, { keyHash, key, endpoint, created: now, lastSeen: now });
    const list = this.#perKey.get(keyHash) ?? [];
    list.push(sid);
    this.#perKey.set(keyHash, list);
    return true;
  }

  check(sid: string, keyHash: string, endpoint: string): boolean {
    const b = this.#map.get(sid);
    if (!b) return false;
    const now = this.#now();
    if (this.#expired(b, now)) { this.#remove(sid, 'expired'); return false; }
    if (b.keyHash !== keyHash || b.endpoint !== endpoint) return false;
    b.lastSeen = now;
    return true;
  }

  /** Marks a session as active (e.g. while it has an open stream). */
  touch(sid: string): void {
    const b = this.#map.get(sid);
    if (b) b.lastSeen = this.#now();
  }

  unbind(sid: string): void { this.#remove(sid, 'unbound'); }

  sweep(): void {
    const now = this.#now();
    for (const [sid, b] of [...this.#map]) if (this.#expired(b, now)) this.#remove(sid, 'expired');
  }

  #remove(sid: string, reason: RemoveReason): void {
    const b = this.#map.get(sid);
    if (!b) return;
    this.#map.delete(sid);
    const own = this.#perKey.get(b.keyHash);
    if (own) {
      const rest = own.filter((s) => s !== sid);
      if (rest.length) this.#perKey.set(b.keyHash, rest); else this.#perKey.delete(b.keyHash);
    }
    this.#opts.onRemove?.(sid, { key: b.key, keyHash: b.keyHash, endpoint: b.endpoint }, reason);
  }

  #expired(b: Binding, now: number): boolean {
    return now - b.lastSeen > this.#opts.idleMs || now - b.created > this.#opts.lifetimeMs;
  }
}
