import { describe, it, expect, vi, afterEach } from 'vitest';
import { EUROUTER_KEY_INVALID, EUROUTER_ROUTE_UNAVAILABLE, LLM_TIMEOUT_ERROR, NO_TOOL_CALLS_ERROR } from '@mindbase/core';
import { publicCompileError, publicCompileSummary, COMPILE_ERROR_MESSAGES } from './compile-errors.js';

// LBV2-32 audit L1: provider bodies (`HTTP n: <body>`) never reach web users; they go to the log.
afterEach(() => { vi.restoreAllMocks(); });

describe('publicCompileError', () => {
  it.each([
    [NO_TOOL_CALLS_ERROR], [EUROUTER_KEY_INVALID], [EUROUTER_ROUTE_UNAVAILABLE], [LLM_TIMEOUT_ERROR],
  ])('passes fixed, actionable messages through: %s', (msg) => {
    expect(publicCompileError(msg)).toBe(msg);
  });

  it.each([
    ['HTTP 401: {"error":"key sk-live-SECRET"}', COMPILE_ERROR_MESSAGES.auth],
    ['HTTP 403: forbidden for org 42', COMPILE_ERROR_MESSAGES.auth],
    ['HTTP 429: slow down, tenant 9', COMPILE_ERROR_MESSAGES.rateLimited],
    ['HTTP 400: estimated tokens exceed context for provider xyz', COMPILE_ERROR_MESSAGES.rejected],
    ['HTTP 413: too large', COMPILE_ERROR_MESSAGES.rejected],
    ['HTTP 502: upstream 10.0.0.5 exploded', COMPILE_ERROR_MESSAGES.unavailable],
    ['HTTP 503: no providers', COMPILE_ERROR_MESSAGES.unavailable],
    ['ECONNRESET at 10.0.0.5:443', COMPILE_ERROR_MESSAGES.generic],
    ['', COMPILE_ERROR_MESSAGES.generic],
  ])('maps %j to a fixed message and logs the raw text', (raw, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(publicCompileError(raw)).toBe(expected);
    if (raw) expect(String(warn.mock.calls[0]?.[0])).toContain(raw.slice(0, 20));
  });

  it('never returns provider detail', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(publicCompileError('HTTP 400: PROVIDERDETAIL')).not.toContain('PROVIDERDETAIL');
  });
});

describe('publicCompileSummary', () => {
  it('maps the error inside a "Compile failed:" summary', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(publicCompileSummary('Compile failed: HTTP 500: PROVIDERDETAIL')).toBe(`Compile failed: ${COMPILE_ERROR_MESSAGES.unavailable}`);
  });
  it('leaves other summaries alone', () => {
    expect(publicCompileSummary('create_concept → basel')).toBe('create_concept → basel');
  });
});
