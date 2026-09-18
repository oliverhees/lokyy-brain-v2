import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, errorMessage, fieldMessage } from './api.ts';

afterEach(() => vi.restoreAllMocks());

const reply = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('sends JSON with the CSRF token on mutations, none on GET', async () => {
    const calls: [string, RequestInit][] = [];
    const api = createApi(async (url, init) => { calls.push([String(url), init ?? {}]); return reply(200, { ok: 1 }); });
    api.setCsrf('tok');
    await api.get('/api/me');
    await api.post('/api/admin/users', { a: 1 });
    expect(new Headers(calls[0]![1].headers).get('x-csrf-token')).toBeNull();
    const h = new Headers(calls[1]![1].headers);
    expect(h.get('x-csrf-token')).toBe('tok');
    expect(h.get('content-type')).toBe('application/json');
    expect(calls[1]![1].body).toBe('{"a":1}');
    expect(calls[1]![1].credentials).toBe('same-origin');
  });

  it('returns null for 204', async () => {
    const api = createApi(async () => new Response(null, { status: 204 }));
    expect(await api.post('/x')).toBeNull();
  });

  it('turns error bodies into ApiError with code and field codes', async () => {
    const api = createApi(async () => reply(400, { error: 'invalid_input', fields: { email: 'format' } }));
    const e = await api.post('/x', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'invalid_input', fields: { email: 'format' } });
  });

  it('maps network failures to code network', async () => {
    const api = createApi(async () => { throw new TypeError('Failed to fetch'); });
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});

describe('German messages', () => {
  it('known codes, generic fallbacks, status based messages', () => {
    expect(errorMessage(new ApiError(409, 'no_free_slot'))).toMatch(/Vault-Plätze/);
    expect(errorMessage(new ApiError(403, 'csrf'))).toMatch(/Sitzung/);
    expect(errorMessage(new ApiError(403, 'forbidden'))).toMatch(/Berechtigung/);
    expect(errorMessage(new ApiError(429, 'rate_limited'))).toMatch(/Zu viele/);
    expect(errorMessage(new ApiError(0, 'network'))).toMatch(/Verbindung/);
    expect(errorMessage(new ApiError(500, 'weird'))).toMatch(/nicht geklappt/);
    expect(errorMessage(new Error('x'))).toMatch(/nicht geklappt/);
    expect(fieldMessage('reserved')).toMatch(/reserviert/);
    expect(fieldMessage('nope')).toMatch(/Ungültig/);
  });
});
