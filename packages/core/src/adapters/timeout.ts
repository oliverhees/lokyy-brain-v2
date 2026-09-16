export const LLM_TIMEOUT_ENV = 'MINDBASE_LLM_TIMEOUT_MS';
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MIN_LLM_TIMEOUT_MS = 1_000;
const MAX_LLM_TIMEOUT_MS = 3_600_000;

/** Error text surfaced to callers; provider URLs and low-level causes stay out of it. */
export const LLM_TIMEOUT_ERROR = 'LLM provider did not respond in time';

/** Reads MINDBASE_LLM_TIMEOUT_MS; throws on anything but an integer in [1000, 3600000]. */
export function readLlmTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[LLM_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_LLM_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < MIN_LLM_TIMEOUT_MS || value > MAX_LLM_TIMEOUT_MS) {
    throw new Error(`${LLM_TIMEOUT_ENV} must be an integer between ${MIN_LLM_TIMEOUT_MS} and ${MAX_LLM_TIMEOUT_MS}`);
  }
  return value;
}

/**
 * Inactivity deadline for one provider request. Every awaited provider step
 * (connect + response headers, error body, each stream read) must settle within
 * `ms`; otherwise the request is aborted and the step rejects with
 * LLM_TIMEOUT_ERROR. Answers that keep streaming are never cut off, and time
 * spent by the consumer between chunks does not count.
 */
export class RequestDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  timedOut = false;

  constructor(private readonly ms: number) {}

  /** fetch bound to this deadline (the abort signal is attached). */
  fetch(impl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
    return this.race(impl(url, { ...init, signal: this.controller.signal }));
  }

  /** Resolve with `p`, or reject after `ms` even if `p` ignores the abort signal. */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.timedOut) return Promise.reject(new Error(LLM_TIMEOUT_ERROR));
    return new Promise<T>((resolve, reject) => {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        reject(new Error(LLM_TIMEOUT_ERROR));
        this.controller.abort();
      }, this.ms);
      // A pending deadline must never keep the process alive.
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
      p.then(
        (v) => { this.clear(); resolve(v); },
        (e: unknown) => { this.clear(); reject(e); },
      );
    });
  }

  /** Map a caught error to the message yielded to callers. */
  message(e: unknown): string {
    return this.timedOut ? LLM_TIMEOUT_ERROR : (e as Error).message;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
