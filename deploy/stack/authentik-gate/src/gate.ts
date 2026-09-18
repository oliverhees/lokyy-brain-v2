// authentik-gate (LBV2-28): the only holder of the Authentik service-account token. The setup portal
// calls this narrow API with a shared bearer secret; the gate fetches every target user from Authentik
// and refuses anything that is not a portal-managed employee (policy.ts). No passthrough, no password
// endpoint, generic errors, audit lines without secrets, body and rate limits.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isAllowedGroup, targetRefusal, validateCreate, validateUpdate, type AuthentikUserLike } from './policy.ts';

export interface GateOptions {
  authentikUrl: string;
  authentikToken: string;
  /** shared bearer secret of the portal */
  secret: string;
  log: (line: string) => void;
  ratePerMinute?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
  /** fetch used for Authentik (tests inject a fake) */
  fetch?: typeof fetch;
}

export interface GateRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  /** raw body; null when larger than the limit */
  body: Buffer | null;
}

export interface GateResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RawUser extends AuthentikUserLike {
  pk: number;
  username: string;
  name?: string;
  email?: string;
  is_active?: boolean;
  path?: string;
  attributes?: Record<string, unknown>;
  groups?: string[];
  groups_obj?: { pk: string; name: string; is_superuser?: boolean }[];
}

class GateError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

const DURATION = /^(days|hours)=(\d{1,3})$/;
const MANAGED_PATH = 'lokyy';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Transport-independent core of the gate (the HTTP server below and in-process tests use it). */
export function createGateHandler(o: GateOptions): (req: GateRequest) => Promise<GateResponse> {
  const doFetch = o.fetch ?? fetch;
  const base = o.authentikUrl.replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? 15_000;
  const rate = o.ratePerMinute ?? 120;
  const secretDigest = digest(o.secret);
  let bucket = { count: 0, reset: 0 };
  const groupPks = new Map<string, string>();

  const audit = (entry: Record<string, unknown>) => o.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

  // ---------------------------------------------------------------- Authentik
  async function ak<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; data: T }> {
    const url = new URL(`${base}/api/v3${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${o.authentikToken}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new GateError(502, 'upstream');
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (res.status === 404) return { status: 404, data: data as T };
    if (!res.ok) {
      if (res.status === 400 && JSON.stringify(data).includes('No recovery flow')) throw new GateError(424, 'no_recovery_flow');
      if (res.status === 400 && JSON.stringify(data).includes('not applicable')) throw new GateError(403, 'forbidden_target');
      o.log(`authentik ${method} ${path}: HTTP ${res.status}`); // status only, never the body
      throw new GateError(502, 'upstream');
    }
    return { status: res.status, data: data as T };
  }

  async function groupPk(name: string): Promise<string> {
    const cached = groupPks.get(name);
    if (cached) return cached;
    const { data } = await ak<{ results: { pk: string; name: string }[] }>('GET', '/core/groups/', undefined, { name });
    const hit = (data?.results ?? []).find((g) => g.name === name);
    if (!hit) throw new GateError(422, 'group_missing');
    groupPks.set(name, hit.pk);
    return hit.pk;
  }

  async function findByUsername(username: string): Promise<RawUser | null> {
    const { data } = await ak<{ results: RawUser[] }>('GET', '/core/users/', undefined, { username, include_groups: 'true' });
    return (data?.results ?? []).find((u) => u.username === username) ?? null;
  }

  /** The target, fetched fresh from Authentik; 404 if missing, 403 unless it is a managed employee. */
  async function target(pk: number): Promise<RawUser> {
    const { status, data } = await ak<RawUser>('GET', `/core/users/${pk}/`, undefined, { include_groups: 'true' });
    if (status === 404 || !data) throw new GateError(404, 'not_found');
    if (targetRefusal(data)) {
      audit({ action: 'refused', target: data.username, pk, reason: targetRefusal(data) });
      throw new GateError(403, 'forbidden_target');
    }
    return data;
  }

  const view = (u: RawUser) => ({
    pk: u.pk, username: u.username, name: u.name ?? '', email: u.email ?? '', isActive: u.is_active === true,
    slot: typeof u.attributes?.['lokyy_slot'] === 'string' ? u.attributes['lokyy_slot'] : null,
    groups: (u.groups_obj ?? []).map((g) => g.name).sort(),
  });

  // ---------------------------------------------------------------- operations
  async function handle(method: string, path: string, body: unknown): Promise<{ status: number; body?: unknown }> {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/users') {
      const { data } = await ak<{ results: RawUser[] }>('GET', '/core/users/', undefined, { path: MANAGED_PATH, include_groups: 'true', page_size: '500' });
      return { status: 200, body: { users: (data?.results ?? []).filter((u) => targetRefusal(u) === null).map(view) } };
    }
    if (method === 'POST' && path === '/v1/users/lookup') {
      const username = (body as { username?: unknown })?.username;
      if (typeof username !== 'string' || !/^[A-Za-z0-9_.@+-]{1,150}$/.test(username)) throw new GateError(400, 'invalid_input');
      const u = await findByUsername(username);
      if (!u) return { status: 200, body: { status: 'absent' } };
      // Nothing about accounts the portal may not manage leaves the gate.
      return { status: 200, body: targetRefusal(u) === null ? { status: 'managed', user: view(u) } : { status: 'foreign' } };
    }
    if (method === 'POST' && path === '/v1/users') {
      const v = validateCreate(body);
      if (!v.ok) throw new GateError(400, 'invalid_input');
      if (await findByUsername(v.value.username)) throw new GateError(409, 'exists');
      const groups = await Promise.all(v.value.groups.map(groupPk));
      const { data } = await ak<RawUser>('POST', '/core/users/', {
        username: v.value.username, name: v.value.name, email: v.value.email, is_active: true, path: MANAGED_PATH,
        attributes: { lokyy_managed: true, lokyy_slot: v.value.slot }, groups,
      });
      const created = await target(data.pk);
      audit({ action: 'create', target: created.username, pk: created.pk, groups: v.value.groups });
      return { status: 201, body: { user: view(created) } };
    }
    if ((m = /^\/v1\/users\/(\d{1,10})$/.exec(path))) {
      const pk = Number(m[1]);
      if (method === 'PATCH') {
        const v = validateUpdate(body);
        if (!v.ok) throw new GateError(400, 'invalid_input');
        const u = await target(pk);
        const patch: Record<string, unknown> = {};
        if (v.value.name !== undefined) patch['name'] = v.value.name;
        if (v.value.email !== undefined) patch['email'] = v.value.email;
        if (v.value.isActive !== undefined) patch['is_active'] = v.value.isActive;
        if (v.value.groups !== undefined) {
          // Only allowlisted groups are managed; any other membership stays as it is.
          const keep = (u.groups_obj ?? []).filter((g) => !isAllowedGroup(g.name)).map((g) => g.pk);
          patch['groups'] = [...new Set([...keep, ...(await Promise.all(v.value.groups.map(groupPk)))])];
        }
        await ak('PATCH', `/core/users/${pk}/`, patch);
        const after = await target(pk);
        audit({ action: 'update', target: u.username, pk, fields: Object.keys(v.value) });
        return { status: 200, body: { user: view(after) } };
      }
      if (method === 'DELETE') {
        const u = await target(pk);
        await ak('DELETE', `/core/users/${pk}/`);
        audit({ action: 'delete', target: u.username, pk });
        return { status: 204 };
      }
    }
    if ((m = /^\/v1\/users\/(\d{1,10})\/recovery$/.exec(path)) && method === 'POST') {
      const d = DURATION.exec(String((body as { tokenDuration?: unknown })?.tokenDuration ?? ''));
      if (!d || Number(d[2]) < 1 || Number(d[2]) * (d[1] === 'days' ? 24 : 1) > 14 * 24) throw new GateError(400, 'invalid_input');
      const u = await target(Number(m[1]));
      const { data } = await ak<{ link?: string }>('POST', `/core/users/${u.pk}/recovery/`, { token_duration: `${d[1]}=${d[2]}` });
      if (typeof data?.link !== 'string' || !/^https?:\/\//.test(data.link)) throw new GateError(502, 'upstream');
      audit({ action: 'recovery_link', target: u.username, pk: u.pk, duration: `${d[1]}=${d[2]}` }); // never the link
      return { status: 200, body: { link: data.link } };
    }
    if ((m = /^\/v1\/users\/(\d{1,10})\/sessions$/.exec(path)) && method === 'DELETE') {
      const u = await target(Number(m[1]));
      const { data } = await ak<{ results: { uuid: string }[] }>('GET', '/core/authenticated_sessions/', undefined, { user__username: u.username });
      for (const s of data?.results ?? []) await ak('DELETE', `/core/authenticated_sessions/${encodeURIComponent(s.uuid)}/`);
      audit({ action: 'end_sessions', target: u.username, pk: u.pk, count: (data?.results ?? []).length });
      return { status: 204 };
    }
    throw new GateError(404, 'not_found');
  }

  return async (req) => {
    const auth = req.authorization;
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(digest(given), secretDigest)) return { status: 401, body: { error: 'unauthorized' } };
    const t = Date.now();
    if (bucket.reset <= t) bucket = { count: 0, reset: t + 60_000 };
    if (++bucket.count > rate) return { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': String(Math.ceil((bucket.reset - t) / 1000)) } };
    if (req.body === null) return { status: 413, body: { error: 'too_large' } };
    let body: unknown;
    if (req.body.length > 0) {
      try { body = JSON.parse(req.body.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
    }
    try {
      return await handle(req.method, req.path.split('?')[0]!, body);
    } catch (e) {
      if (e instanceof GateError) return { status: e.status, body: { error: e.message } };
      o.log(`internal error: ${(e as Error).message}`);
      return { status: 500, body: { error: 'internal' } };
    }
  };
}

export function createGate(o: GateOptions): http.Server {
  const handler = createGateHandler(o);
  const maxBody = o.maxBodyBytes ?? 16 * 1024;
  const server = http.createServer((req, res) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= maxBody) chunks.push(c);
    });
    req.on('end', () => {
      handler({ method: req.method ?? 'GET', path: req.url ?? '/', authorization: req.headers.authorization, body: size > maxBody ? null : Buffer.concat(chunks) })
        .then((r) => {
          res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...r.headers });
          res.end(r.body === undefined ? '' : JSON.stringify(r.body));
        });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
