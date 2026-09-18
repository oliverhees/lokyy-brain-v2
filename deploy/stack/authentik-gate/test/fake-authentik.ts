// In-memory Authentik 2026.8 API (the parts the gate uses) as a real HTTP server for the gate tests.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  pk: number; username: string; name: string; email: string; is_active: boolean; type: string; path: string;
  attributes: Record<string, unknown>; groups: string[];
}

export class FakeAuthentik {
  users = new Map<number, FakeUser>();
  groups = new Map<string, { name: string; is_superuser: boolean }>();
  sessions: { uuid: string; username: string }[] = [];
  requests: { method: string; path: string; auth: string | undefined }[] = [];
  recoveryFlowSet = true;
  #next = 100;
  server: http.Server;
  url = '';

  constructor(token: string) {
    for (const [i, g] of ['vault-v01', 'vault-v02', 'vault-firma-read', 'vault-firma-write', 'lokyy-users', 'lokyy-admins'].entries()) {
      this.groups.set(`g-${i}`, { name: g, is_superuser: false });
    }
    this.groups.set('g-su', { name: 'authentik Admins', is_superuser: true });
    this.addUser({ username: 'akadmin', groups: ['g-su', 'g-5'] });
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        this.requests.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization });
        const send = (status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
        if (req.headers.authorization !== `Bearer ${token}`) return send(403, { detail: 'no' });
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        this.#route(req.method ?? 'GET', url, body, send);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): void { this.server.closeAllConnections(); this.server.close(); }

  addUser(u: Partial<FakeUser> & { username: string }): FakeUser {
    const user: FakeUser = { pk: this.#next++, name: u.username, email: '', is_active: true, type: 'internal', path: 'users', attributes: {}, groups: [], ...u };
    this.users.set(user.pk, user);
    return user;
  }

  groupPk(name: string): string { return [...this.groups].find(([, g]) => g.name === name)![0]; }
  groupNames(pk: number): string[] { return this.users.get(pk)!.groups.map((g) => this.groups.get(g)!.name).sort(); }

  #ser(u: FakeUser) {
    const groups_obj = u.groups.map((g) => ({ pk: g, ...this.groups.get(g)! }));
    return { ...u, is_superuser: groups_obj.some((g) => g.is_superuser), groups_obj };
  }

  #route(method: string, url: URL, body: Record<string, unknown> | undefined, send: (s: number, b?: unknown) => void): void {
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (p === '/api/v3/core/users/' && method === 'GET') {
      const name = url.searchParams.get('username');
      const path = url.searchParams.get('path');
      return send(200, { results: [...this.users.values()].filter((u) => (name === null || u.username === name) && (path === null || u.path === path)).map((u) => this.#ser(u)) });
    }
    if (p === '/api/v3/core/users/' && method === 'POST') {
      if ([...this.users.values()].some((u) => u.username === body!['username'])) return send(400, { username: ['unique'] });
      return send(201, this.#ser(this.addUser(body as unknown as FakeUser)));
    }
    if ((m = /^\/api\/v3\/core\/users\/(\d+)\/$/.exec(p))) {
      const u = this.users.get(Number(m[1]));
      if (!u) return send(404, { detail: 'Not found.' });
      if (method === 'GET') return send(200, this.#ser(u));
      if (method === 'PATCH') { Object.assign(u, body); return send(200, this.#ser(u)); }
      if (method === 'DELETE') { this.users.delete(u.pk); return send(204); }
    }
    if ((m = /^\/api\/v3\/core\/users\/(\d+)\/recovery\/$/.exec(p)) && method === 'POST') {
      if (!this.recoveryFlowSet) return send(400, { non_field_errors: ['No recovery flow set.'] });
      return send(200, { link: `http://authentik-server:9000/if/flow/lokyy-set-password/?flow_token=t${m[1]}` });
    }
    if ((m = /^\/api\/v3\/core\/users\/(\d+)\/set_password\/$/.exec(p))) return send(204);
    if (p === '/api/v3/core/groups/' && method === 'GET') {
      const name = url.searchParams.get('name');
      return send(200, { results: [...this.groups].filter(([, g]) => name === null || g.name === name).map(([pk, g]) => ({ pk, ...g })) });
    }
    if (p === '/api/v3/core/authenticated_sessions/' && method === 'GET') {
      return send(200, { results: this.sessions.filter((s) => s.username === url.searchParams.get('user__username')).map((s) => ({ uuid: s.uuid })) });
    }
    if ((m = /^\/api\/v3\/core\/authenticated_sessions\/([^/]+)\/$/.exec(p)) && method === 'DELETE') {
      this.sessions = this.sessions.filter((s) => s.uuid !== m![1]);
      return send(204);
    }
    return send(404, { detail: `no route ${method} ${p}` });
  }
}
