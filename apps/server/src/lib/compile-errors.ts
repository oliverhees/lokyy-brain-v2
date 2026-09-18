import { EUROUTER_KEY_INVALID, EUROUTER_ROUTE_UNAVAILABLE, LLM_TIMEOUT_ERROR, NO_TOOL_CALLS_ERROR } from '@mindbase/core';

/** Fixed texts web users see for compile failures (LBV2-32 audit L1). */
export const COMPILE_ERROR_MESSAGES = {
  auth: 'The LLM provider rejected the API key. Check it in Settings.',
  rateLimited: 'The LLM provider is rate limiting requests. Try again in a moment.',
  rejected: 'The LLM provider rejected the request. Try a shorter source, or another model or route.',
  unavailable: 'The LLM provider is temporarily unavailable. Try again in a moment.',
  generic: 'Compile failed. Details are in the server log.',
} as const;

/** Messages written for users already; they carry no provider detail. */
const PASS_THROUGH = new Set<string>([NO_TOOL_CALLS_ERROR, EUROUTER_KEY_INVALID, EUROUTER_ROUTE_UNAVAILABLE, LLM_TIMEOUT_ERROR]);

/**
 * Maps a compile error to a fixed user-facing message. Adapter errors look like
 * `HTTP <status>: <provider body>`; the body can echo prompt fragments, hosts or
 * account details, so it only goes to the server log.
 */
export function publicCompileError(raw: string): string {
  if (PASS_THROUGH.has(raw)) return raw;
  if (raw) console.warn(`[compile] ${raw.slice(0, 500)}`);
  const status = Number(/^HTTP (\d{3})\b/.exec(raw)?.[1]);
  if (status === 401 || status === 403) return COMPILE_ERROR_MESSAGES.auth;
  if (status === 429) return COMPILE_ERROR_MESSAGES.rateLimited;
  if (status >= 400 && status < 500) return COMPILE_ERROR_MESSAGES.rejected;
  if (status >= 500) return COMPILE_ERROR_MESSAGES.unavailable;
  return COMPILE_ERROR_MESSAGES.generic;
}

const FAILED_PREFIX = 'Compile failed: ';

/** compileL1's `complete` summary embeds the raw error as "Compile failed: <error>". */
export function publicCompileSummary(summary: string): string {
  return summary.startsWith(FAILED_PREFIX) ? `${FAILED_PREFIX}${publicCompileError(summary.slice(FAILED_PREFIX.length))}` : summary;
}
