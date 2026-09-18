// In-memory stand-in for MetaMCP 2.4.22 as far as provisioning touches it: its Postgres tables
// (users, accounts, sessions, api_keys), better-auth email sign-in, the frontend tRPC procedures
// used by deploy/stack/metamcp/provision.mjs and the /metamcp/<endpoint>/mcp tools/list path.
import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { READ_TOOLS } from './metamcp.ts';

export const ALL_TOOLS = [...READ_TOOLS, 'write_wiki_page', 'ingest_url', 'delete_note'];

interface Row { [k: string]: unknown }
interface Server { uuid: string; user_id: string; name: string; url: string; bearerToken: string; type: string; description: string }
interface Namespace { uuid: string; user_id: string; name: string; description: string; servers: string[] }
interface Endpoint { uuid: string; user_id: string; name: string; namespace_uuid: string; enable_api_key_auth: boolean; enable_oauth: boolean; use_query_param_auth: boolean }
interface ApiKey { uuid: string; user_id: string; name: string; key: string; is_active: boolean }

const verify = (password: string, hash: string): Promise<boolean> => new Promise((resolve) => {
  const [salt, key] = hash.split(':');
  scrypt(password.normalize('NFKC'), salt!, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 }, (err, dk) => {
    resolve(!err && timingSafeEqual(dk, Buffer.from(key!, 'hex')));
  });
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeMetamcp {
  users = new Map<string, { id: string; name: string; email: string }>();
  accounts = new Map<string, string>(); // user id → password hash
  sessions = new Map<string, string>(); // cookie token → user id
  servers: Server[] = [];
  namespaces: Namespace[] = [];
  endpoints: Endpoint[] = [];
  apiKeys: ApiKey[] = [];
  inactiveTools = new Set<string>(); // "<server>__<tool>"
  mcpSessions = new Map<string, string>(); // session id → endpoint name
  mutations: string[] = [];
  failProc: string | null = null;
  maxConcurrentLogins = 0;
  toolsByToken: Record<string, string[]>;

  constructor(toolsByToken: Record<string, string[]>) {
    this.toolsByToken = toolsByToken;
  }

  serversOf(userId: string) {
    return this.servers.filter((s) => s.user_id === userId).map(({ name, url, bearerToken }) => ({ name, url, bearerToken }));
  }

  // ------------------------------------------------------------- Postgres
  db = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
      const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      const p = params as string[];
      if (s.startsWith('insert into users')) {
        const existing = this.users.get(p[0]!);
        this.users.set(p[0]!, { id: p[0]!, name: p[1]!, email: existing?.email ?? p[2]! });
        return { rows: [] };
      }
      if (s.startsWith('delete from accounts where user_id')) { this.accounts.delete(p[0]!); return { rows: [] }; }
      if (s.startsWith('insert into accounts')) { this.accounts.set(p[1]!, p[2]!); return { rows: [] }; }
      if (s.startsWith('delete from sessions where user_id')) {
        for (const [c, u] of this.sessions) if (u === p[0]) this.sessions.delete(c);
        this.#logins = Math.max(0, this.#logins - 1);
        return { rows: [] };
      }
      if (s.startsWith('select id from users where id like')) {
        const prefix = p[0]!.replace(/%$/, '');
        return { rows: [...this.users.keys()].filter((id) => id.startsWith(prefix)).map((id) => ({ id })) };
      }
      if (s.startsWith('delete from users where id')) {
        const id = p[0]!;
        this.users.delete(id);
        this.servers = this.servers.filter((x) => x.user_id !== id);
        this.namespaces = this.namespaces.filter((x) => x.user_id !== id);
        this.endpoints = this.endpoints.filter((x) => x.user_id !== id);
        this.apiKeys = this.apiKeys.filter((x) => x.user_id !== id);
        return { rows: [] };
      }
      if (s.startsWith('select key from api_keys')) {
        return { rows: this.apiKeys.filter((k) => k.user_id === p[0] && k.name === p[1] && k.is_active).map((k) => ({ key: k.key })) };
      }
      throw new Error(`fake db: unexpected query ${sql}`);
    },
  };
  #logins = 0;

  // ------------------------------------------------------------- HTTP
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;

    if (url.pathname === '/api/auth/sign-in/email' && method === 'POST') {
      if (!headers.get('origin')) return json(403, { message: 'missing origin' });
      const user = [...this.users.values()].find((u) => u.email === body.email);
      const hash = user && this.accounts.get(user.id);
      if (!user || !hash || !(await verify(body.password, hash))) return json(401, { message: 'invalid' });
      const token = randomUUID();
      this.sessions.set(token, user.id);
      this.#logins += 1;
      this.maxConcurrentLogins = Math.max(this.maxConcurrentLogins, this.#logins);
      return json(200, { ok: true }, { 'set-cookie': `better-auth.session_token=${token}; Path=/; HttpOnly` });
    }

    const trpc = /^\/trpc\/frontend\.(.+)$/.exec(url.pathname);
    if (trpc) {
      const proc = trpc[1]!;
      const cookie = headers.get('cookie') ?? '';
      const userId = this.sessions.get(/better-auth\.session_token=([^;]+)/.exec(cookie)?.[1] ?? '');
      if (!userId) return json(401, { error: { message: 'UNAUTHORIZED' } });
      const input = method === 'POST' ? body : url.searchParams.get('input') ? JSON.parse(url.searchParams.get('input')!) : undefined;
      if (method === 'POST') this.mutations.push(proc);
      if (this.failProc === proc) return json(500, { error: { message: `boom in ${proc}` } });
      const data = this.#trpc(proc, userId, input);
      return json(200, { result: { data } });
    }

    const mcp = /^\/metamcp\/([a-z0-9-]+)\/mcp$/.exec(url.pathname);
    if (mcp) return this.#mcp(mcp[1]!, method, headers, body);
    return json(404, { error: 'not found' });
  };

  #trpc(proc: string, userId: string, input: Row | undefined): unknown {
    const i = (input ?? {}) as Row;
    switch (proc) {
      case 'mcpServers.list': return { data: this.servers };
      case 'mcpServers.create': {
        const s: Server = { uuid: randomUUID(), user_id: userId, name: String(i['name']), url: String(i['url']), bearerToken: String(i['bearerToken']), type: String(i['type']), description: String(i['description']) };
        this.servers.push(s);
        return { success: true, data: s };
      }
      case 'mcpServers.update': {
        const s = this.servers.find((x) => x.uuid === i['uuid'] && x.user_id === userId)!;
        Object.assign(s, { url: i['url'], bearerToken: i['bearerToken'], type: i['type'] });
        return { success: true, data: s };
      }
      case 'mcpServers.delete': this.servers = this.servers.filter((x) => !(x.uuid === i['uuid'] && x.user_id === userId)); return { success: true };
      case 'namespaces.list': return { data: this.namespaces };
      case 'namespaces.create': {
        const n: Namespace = { uuid: randomUUID(), user_id: userId, name: String(i['name']), description: String(i['description']), servers: i['mcpServerUuids'] as string[] };
        this.namespaces.push(n);
        return { success: true, data: n };
      }
      case 'namespaces.get': {
        const n = this.namespaces.find((x) => x.uuid === i['uuid'])!;
        return { data: { ...n, servers: n.servers.map((uuid) => ({ uuid })) } };
      }
      case 'namespaces.update': {
        const n = this.namespaces.find((x) => x.uuid === i['uuid'] && x.user_id === userId)!;
        n.servers = i['mcpServerUuids'] as string[];
        return { success: true };
      }
      case 'namespaces.delete': this.namespaces = this.namespaces.filter((x) => !(x.uuid === i['uuid'] && x.user_id === userId)); return { success: true };
      case 'namespaces.refreshTools': return { success: true };
      case 'namespaces.getTools': {
        const n = this.namespaces.find((x) => x.uuid === i['namespaceUuid'])!;
        return { data: n.servers.flatMap((su) => {
          const s = this.servers.find((x) => x.uuid === su)!;
          return (this.toolsByToken[s.bearerToken] ?? []).map((t) => ({ uuid: `${s.name}__${t}`, name: t, serverName: s.name, serverUuid: s.uuid }));
        }) };
      }
      case 'namespaces.updateToolStatus': this.inactiveTools.add(String(i['toolUuid'])); return { success: true };
      case 'endpoints.list': return { data: this.endpoints };
      case 'endpoints.create': {
        this.endpoints.push({ uuid: randomUUID(), user_id: userId, name: String(i['name']), namespace_uuid: String(i['namespaceUuid']),
          enable_api_key_auth: Boolean(i['enableApiKeyAuth']), enable_oauth: Boolean(i['enableOauth']), use_query_param_auth: Boolean(i['useQueryParamAuth']) });
        return { success: true };
      }
      case 'endpoints.update': {
        const e = this.endpoints.find((x) => x.uuid === i['uuid'] && x.user_id === userId)!;
        Object.assign(e, { namespace_uuid: i['namespaceUuid'], enable_api_key_auth: i['enableApiKeyAuth'], enable_oauth: i['enableOauth'], use_query_param_auth: i['useQueryParamAuth'] });
        return { success: true };
      }
      case 'endpoints.delete': this.endpoints = this.endpoints.filter((x) => !(x.uuid === i['uuid'] && x.user_id === userId)); return { success: true };
      case 'apiKeys.list': return { apiKeys: this.apiKeys.filter((k) => k.user_id === userId) };
      case 'apiKeys.create': {
        const k: ApiKey = { uuid: randomUUID(), user_id: userId, name: String(i['name']), key: `sk_mt_${randomUUID().replace(/-/g, '')}`, is_active: true };
        this.apiKeys.push(k);
        return { ...k };
      }
      case 'apiKeys.delete': this.apiKeys = this.apiKeys.filter((k) => !(k.uuid === i['uuid'] && k.user_id === userId)); return { success: true };
      default: throw new Error(`fake trpc: unexpected ${proc}`);
    }
  }

  #mcp(endpoint: string, method: string, headers: Headers, body: Row | undefined): Response {
    const ep = this.endpoints.find((e) => e.name === endpoint);
    const key = headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '');
    if (!ep || !this.apiKeys.some((k) => k.key === key && k.user_id === ep.user_id && k.is_active)) return json(401, { error: 'unauthorized' });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    if (body?.['method'] === 'initialize') {
      const sid = randomUUID();
      this.mcpSessions.set(sid, endpoint);
      return json(200, { jsonrpc: '2.0', id: body['id'], result: {} }, { 'mcp-session-id': sid });
    }
    if (body?.['method'] === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body?.['method'] === 'tools/list') {
      const ns = this.namespaces.find((n) => n.uuid === ep.namespace_uuid)!;
      const tools = ns.servers.flatMap((su) => {
        const s = this.servers.find((x) => x.uuid === su)!;
        return (this.toolsByToken[s.bearerToken] ?? []).map((t) => `${s.name}__${t}`).filter((n) => !this.inactiveTools.has(n));
      });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { tools: tools.map((name) => ({ name })) } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(400, { error: 'unsupported' });
  }
}
