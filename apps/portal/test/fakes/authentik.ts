// In-memory stand-in for the parts of the Authentik 2026.8 API the portal uses (/api/v3/core/…).
// Shapes follow authentik/core/api/users.py, groups.py and authenticated_sessions.py.

export interface FakeUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  path: string;
  attributes: Record<string, unknown>;
  groups: string[]; // group pks
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Groups that grant superuser rights, as in a fresh Authentik */
const SUPERUSER_GROUPS: ReadonlySet<string> = new Set(['authentik Admins']);

const json = (status: number, body: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeAuthentik {
  users = new Map<number, FakeUser>();
  groups = new Map<string, string>(); // pk → name
  sessions: { uuid: string; username: string }[] = [];
  /** outpost (proxy) sessions, purged by the lokyy-end-proxy-sessions policy */
  proxySessions: { username: string }[] = [];
  /** the purge policy does not pass (gate answers 502) */
  purgeFails = false;
  requests: RecordedRequest[] = [];
  recoveryRequests: { pk: number; token_duration: unknown }[] = [];
  recoveryFlowSet = true;
  failNext: { status: number; body: string } | null = null;
  #nextPk = 100;

  constructor(groupNames: string[]) {
    groupNames.forEach((name, i) => this.groups.set(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name));
  }

  addUser(u: Partial<FakeUser> & { username: string }): FakeUser {
    const user: FakeUser = { pk: this.#nextPk++, name: u.username, email: '', is_active: true, path: 'users', attributes: {}, groups: [], ...u };
    this.users.set(user.pk, user);
    return user;
  }

  groupPk(name: string): string {
    for (const [pk, n] of this.groups) if (n === name) return pk;
    throw new Error(`fake: no group ${name}`);
  }

  addToGroup(pk: number, name: string): void {
    this.users.get(pk)!.groups.push(this.groupPk(name));
  }

  groupNamesOf(pk: number): string[] {
    return this.users.get(pk)!.groups.map((g) => this.groups.get(g)!).sort();
  }

  userByName(username: string): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.username === username);
  }

  #serialize(u: FakeUser) {
    const groups_obj = u.groups.map((g) => ({ pk: g, name: this.groups.get(g)!, is_superuser: SUPERUSER_GROUPS.has(this.groups.get(g)!) }));
    return { ...u, type: 'internal', is_superuser: groups_obj.some((g) => g.is_superuser), groups_obj };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.toString(), headers, body });
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return new Response(f.body, { status: f.status });
    }
    if (headers['authorization'] !== 'Bearer tok-secret') return json(403, { detail: 'no auth' });
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (path === '/api/v3/core/users/' && method === 'GET') {
      const name = url.searchParams.get('username');
      const upath = url.searchParams.get('path');
      const results = [...this.users.values()].filter((u) => (name === null || u.username === name) && (upath === null || u.path === upath)).map((u) => this.#serialize(u));
      return json(200, { pagination: { count: results.length }, results });
    }
    if (path === '/api/v3/core/users/' && method === 'POST') {
      const b = body as Partial<FakeUser>;
      if (this.userByName(b.username!)) return json(400, { username: ['This field must be unique.'] });
      for (const g of b.groups ?? []) if (!this.groups.has(g)) return json(400, { groups: ['invalid pk'] });
      const u = this.addUser({ username: b.username!, name: b.name ?? '', email: b.email ?? '', is_active: b.is_active ?? true,
        path: b.path ?? 'users', attributes: b.attributes ?? {}, groups: b.groups ?? [] });
      return json(201, this.#serialize(u));
    }
    if ((m = /^\/api\/v3\/core\/users\/(\d+)\/$/.exec(path))) {
      const u = this.users.get(Number(m[1]));
      if (!u) return json(404, { detail: 'Not found.' });
      if (method === 'GET') return json(200, this.#serialize(u));
      if (method === 'PATCH') {
        const b = body as Partial<FakeUser>;
        for (const g of b.groups ?? []) if (!this.groups.has(g)) return json(400, { groups: ['invalid pk'] });
        Object.assign(u, b);
        return json(200, this.#serialize(u));
      }
      if (method === 'DELETE') { this.users.delete(u.pk); return json(204, undefined); }
    }
    if ((m = /^\/api\/v3\/core\/users\/(\d+)\/recovery\/$/.exec(path)) && method === 'POST') {
      const pk = Number(m[1]);
      if (!this.users.has(pk)) return json(404, { detail: 'Not found.' });
      if (!this.recoveryFlowSet) return json(400, { non_field_errors: ['No recovery flow set.'] });
      this.recoveryRequests.push({ pk, token_duration: (body as { token_duration?: unknown }).token_duration });
      return json(200, { link: `https://auth.example.com/if/flow/lokyy-set-password/?flow_token=tok${pk}` });
    }
    if (path === '/api/v3/core/groups/' && method === 'GET') {
      const name = url.searchParams.get('name');
      const results = [...this.groups].filter(([, n]) => name === null || n === name).map(([pk, n]) => ({ pk, name: n }));
      return json(200, { pagination: { count: results.length }, results });
    }
    if (path === '/api/v3/core/authenticated_sessions/' && method === 'GET') {
      const name = url.searchParams.get('user__username');
      return json(200, { results: this.sessions.filter((s) => s.username === name).map((s) => ({ uuid: s.uuid, user: { username: s.username } })) });
    }
    if ((m = /^\/api\/v3\/core\/authenticated_sessions\/([^/]+)\/$/.exec(path)) && method === 'DELETE') {
      this.sessions = this.sessions.filter((s) => s.uuid !== m![1]);
      return json(204, undefined);
    }
    if (path === '/api/v3/policies/all/' && method === 'GET') {
      return json(200, { results: [{ pk: 'pol-purge', name: 'lokyy-end-proxy-sessions' }] });
    }
    if ((m = /^\/api\/v3\/policies\/all\/pol-purge\/test\/$/.exec(path)) && method === 'POST') {
      const u = this.users.get(Number(body?.user));
      if (!u) return json(400, {});
      if (this.purgeFails) return json(200, { passing: false, messages: [] });
      this.proxySessions = this.proxySessions.filter((x) => x.username !== u.username);
      return json(200, { passing: true, messages: [] });
    }
    return json(404, { detail: `fake: no route ${method} ${path}` });
  };
}
