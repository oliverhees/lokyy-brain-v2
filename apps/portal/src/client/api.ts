// Browser API client: same-origin JSON, CSRF header on every mutation, errors as ApiError.
import { de } from '../shared/i18n/de.ts';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  constructor(status: number, code: string, fields: Record<string, string> = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface Api {
  setCsrf(token: string): void;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

export function createApi(fetchFn: FetchFn = (i, init) => fetch(i, init)): Api {
  let csrf = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchFn(path, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw new ApiError(0, 'network');
    }
    if (res.status === 204) return null as T;
    const data = await res.json().catch(() => null) as { error?: string; fields?: Record<string, string> } | null;
    if (!res.ok) throw new ApiError(res.status, data?.error ?? 'http', data?.fields ?? {});
    return data as T;
  }
  return {
    setCsrf: (t) => { csrf = t; },
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
}

export const api = createApi();

export function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return de.errors.generic;
  const known = de.errors.codes[e.code];
  if (known) return known;
  if (e.code === 'network') return de.errors.network;
  if (e.code === 'csrf') return de.errors.csrf;
  if (e.status === 403) return de.errors.forbidden;
  if (e.status === 429) return de.errors.rateLimited;
  return de.errors.generic;
}

export function fieldMessage(code: string): string {
  return de.errors.fields[code] ?? de.errors.fields['invalid']!;
}
