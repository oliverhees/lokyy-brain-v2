// apps/mcp/src/lib/rate-limit.ts
// Sliding-window call limits for LLM-calling tools in read-only sessions (LBV2-18).
// Every reader session has its own budget, and all reader sessions of the read-only
// token share a second, token-wide budget, so opening more sessions cannot multiply
// the number of LLM calls.

export interface ReaderLlmRateLimit {
  /** Max LLM tool calls per read-only session per window (0 = LLM tools disabled for readers). */
  perSession: number;
  /** Max LLM tool calls of all read-only sessions of the token together per window. */
  perToken: number;
  windowMs: number;
}

export const READER_LLM_RATE_DEFAULTS: Readonly<ReaderLlmRateLimit> = Object.freeze({
  perSession: 20,
  perToken: 60,
  windowMs: 10 * 60 * 1000,
});

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

/** Reads the reader LLM limits; throws on invalid values so a typo can never disable the limit. */
export function readerLlmRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): ReaderLlmRateLimit {
  return {
    perSession: intFromEnv(env, 'MCP_HTTP_READONLY_LLM_RATE', READER_LLM_RATE_DEFAULTS.perSession, 0),
    perToken: intFromEnv(env, 'MCP_HTTP_READONLY_LLM_RATE_TOTAL', READER_LLM_RATE_DEFAULTS.perToken, 0),
    windowMs: intFromEnv(env, 'MCP_HTTP_READONLY_LLM_WINDOW_MS', READER_LLM_RATE_DEFAULTS.windowMs, 1000),
  };
}

/** Sliding window of call timestamps. */
export class SlidingWindow {
  private readonly calls: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  hasCapacity(now: number): boolean {
    const cutoff = now - this.windowMs;
    while (this.calls.length > 0 && (this.calls[0] ?? now) <= cutoff) this.calls.shift();
    return this.calls.length < this.limit;
  }

  record(now: number): void {
    this.calls.push(now);
  }
}

/** Takes one call from every window, or from none when any window is exhausted. */
export function acquireAll(windows: readonly SlidingWindow[], now: number = Date.now()): boolean {
  if (!windows.every((w) => w.hasCapacity(now))) return false;
  for (const w of windows) w.record(now);
  return true;
}
