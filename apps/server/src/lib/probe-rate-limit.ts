// Rate limit for config probes that call the LLM provider with a key from the
// request body (POST /api/config/test and POST /api/config/eurouter/rules),
// so a config admin session cannot be used to test keys at speed (LBV2-30, audit L1).
// One shared sliding window per server: the vault serves one user or team.
import type { RequestHandler } from 'express';

export const PROBE_RATE_DEFAULTS = Object.freeze({ limit: 20, windowMs: 60_000 });
const TOO_MANY = 'Too many requests, try again shortly';

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

/** Throws on invalid values so a typo can never disable the limit. */
export function probeRateLimiter(env: NodeJS.ProcessEnv): RequestHandler {
  const limit = intFromEnv(env, 'VAULT_CONFIG_PROBE_RATE', PROBE_RATE_DEFAULTS.limit, 1);
  const windowMs = intFromEnv(env, 'VAULT_CONFIG_PROBE_WINDOW_MS', PROBE_RATE_DEFAULTS.windowMs, 1000);
  const calls: number[] = [];
  return (_req, res, next) => {
    const now = Date.now();
    while (calls.length > 0 && (calls[0] ?? now) <= now - windowMs) calls.shift();
    if (calls.length >= limit) {
      const oldest = calls[0] ?? now;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))));
      res.status(429).json({ ok: false, error: TOO_MANY });
      return;
    }
    calls.push(now);
    next();
  };
}
