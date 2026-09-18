// MetaMCP provisioning for the portal — a port of deploy/stack/metamcp/provision.mjs (LBV2-4/-24)
// that runs in the portal container instead of inside the metamcp container: same reconcile logic,
// same validation, same tripwire, but with the MetaMCP Postgres client and HTTP base injected.
//
// Why one MetaMCP account per user: MetaMCP 2.4.22 binds API keys to endpoints by owner, so per-user
// ownership is the only way to make one user's key useless on another user's endpoint. The accounts
// get a random one-time password for the API calls of a run; their credential account and sessions are
// deleted again at the end, so nobody can log in as them.
//
// Differences to provision.mjs: runs are serialised in-process (the portal is the only caller) instead
// of flock; API keys are never part of the result (readKey() fetches one on demand); MetaMCP cannot
// be restarted from here (no Docker socket) — restartMetamcp is reported, key rotation already makes
// old keys fail on open sessions (MetaMCP checks the key per request, mcp-gate drops the binding).
import { randomBytes, scrypt } from 'node:crypto';
import { READ_ONLY_TOOL_NAMES } from '../../../mcp/src/access.ts';
import type { UsersJson } from './slots.ts';
import type { FetchFn } from './authentik.ts';

export const READ_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);

const ID_PREFIX = 'lokyy-';
const EMAIL_DOMAIN = 'users.lokyy.local';
const KEY_NAME = 'lokyy';
const VAULT_RE = /^[a-z][a-z0-9-]{0,30}$/;
const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ------------------------------------------------------------------ better-auth password hash
// better-auth 1.4.2 (MetaMCP 2.4.22): scrypt N=16384 r=16 p=1 dkLen=64 over NFKC, salt = 16 random
// bytes as hex (used as a string), stored as "<salt>:<hex key>".
export function hashPasswordWithSalt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

export const hashPassword = (password: string): Promise<string> => hashPasswordWithSalt(password, randomBytes(16).toString('hex'));

// ------------------------------------------------------------------ validation (as provision.mjs)
function tokenName(vault: string, readonly = false): string {
  return `MCP_${readonly ? 'READONLY_' : ''}TOKEN_${vault.toUpperCase().replace(/-/g, '_')}`;
}

function token(env: Record<string, string | undefined>, vault: string, readonly = false): string {
  const name = tokenName(vault, readonly);
  const v = env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

export function validateUsersSpec(spec: UsersJson, env: Record<string, string | undefined>): void {
  const company = spec.companyVault;
  if (typeof company !== 'string' || !VAULT_RE.test(company)) throw new Error('invalid companyVault');
  if (!Array.isArray(spec.users)) throw new Error('users must be an array');
  const seen = new Set<string>();
  const vaults = new Set<string>();
  for (const u of spec.users as (UsersJson['users'][number] & { allowVaultNameMismatch?: boolean })[]) {
    if (typeof u.username !== 'string' || !USERNAME_RE.test(u.username) || u.username.includes('--')) throw new Error(`invalid username: ${u.username}`);
    if (typeof u.vault !== 'string' || !VAULT_RE.test(u.vault)) throw new Error(`invalid vault for ${u.username}`);
    if (u.vault !== u.username && u.allowVaultNameMismatch !== true) throw new Error(`${u.username}: vault must equal username (set "allowVaultNameMismatch": true to override)`);
    if (vaults.has(u.vault)) throw new Error(`vault ${u.vault} assigned to more than one user`);
    vaults.add(u.vault);
    if (u.vault === company) throw new Error(`${u.username}: own vault must not be the company vault`);
    if (!['reader', 'writer'].includes(u.role)) throw new Error(`${u.username}: role must be reader or writer`);
    if (seen.has(u.username)) throw new Error(`duplicate user ${u.username}`);
    seen.add(u.username);
    token(env, u.vault);
    token(env, company, u.role === 'reader');
  }
}

// ------------------------------------------------------------------ provisioner
export interface ProvisionedUser {
  username: string;
  role: string;
  vault: string;
  url: string;
  tools?: { total: number; company: number };
}

export interface ProvisionResult {
  status: 'ok' | 'failed';
  error?: string;
  /** Open MetaMCP sessions may still carry outdated upstream credentials (see header comment). */
  restartMetamcp: boolean;
  users: ProvisionedUser[];
}

export interface MetamcpOptions {
  db: Db;
  /** Internal MetaMCP URL, e.g. http://metamcp:12008 */
  baseUrl: string;
  /** Public MCP base, e.g. https://mcp.example.com (endpoint URLs handed to users) */
  publicBase: string;
  /** Origin header for better-auth sign-in; defaults to baseUrl */
  origin?: string;
  fetch?: FetchFn;
  env: Record<string, string | undefined>;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

// The only `any` in the portal: untyped MetaMCP tRPC JSON, used exactly as in the verified provision.mjs.
type Trpc = (proc: string, input?: unknown, mutation?: boolean) => Promise<any>;

interface Client extends ProvisionedUser {
  apiKey: string;
  namespaceUuid: string;
  companyServer: string;
}

export class MetamcpProvisioner {
  readonly #o: Required<Omit<MetamcpOptions, 'origin'>> & { origin: string };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: MetamcpOptions) {
    this.#o = { fetch, log: () => {}, timeoutMs: 30_000, origin: opts.baseUrl, ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, ''), publicBase: opts.publicBase.replace(/\/+$/, '') };
  }

  /** Current API key of a user, or null (read from MetaMCP's database; not stored by the portal). */
  async readKey(username: string): Promise<string | null> {
    const { rows } = await this.#o.db.query(
      'select key from api_keys where user_id = $1 and name = $2 and is_active = true limit 1', [`${ID_PREFIX}${username}`, KEY_NAME]);
    const key = rows[0]?.['key'];
    return typeof key === 'string' ? key : null;
  }

  /** Brings MetaMCP to the state of spec (create, update, remove unlisted lokyy- users). Never throws. */
  reconcile(spec: UsersJson, opts: { rotate?: string[] } = {}): Promise<ProvisionResult> {
    const run = this.#queue.then(() => this.#reconcile(spec, opts.rotate ?? []));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #reconcile(spec: UsersJson, rotateList: string[]): Promise<ProvisionResult> {
    const clients: Client[] = [];
    const state = { restart: false };
    const strip = (c: Client): ProvisionedUser => ({ username: c.username, role: c.role, vault: c.vault, url: c.url, ...(c.tools ? { tools: c.tools } : {}) });
    try {
      validateUsersSpec(spec, this.#o.env);
      const listedNames = new Set(spec.users.map((u) => u.username));
      for (const r of rotateList) if (r !== '*' && !listedNames.has(r)) throw new Error(`rotate ${r}: not provisioned`);
      const rotate = (u: string) => rotateList.includes('*') || rotateList.includes(u);

      for (const u of spec.users) clients.push(await this.#reconcileUser(u, spec.companyVault, rotate(u.username), state));

      const listed = new Set(spec.users.map((u) => `${ID_PREFIX}${u.username}`));
      const { rows } = await this.#o.db.query('select id from users where id like $1', [`${ID_PREFIX}%`]);
      for (const id of rows.map((r) => String(r['id'])).filter((id) => !listed.has(id))) {
        const username = id.slice(ID_PREFIX.length);
        await this.#withLogin(username, async (trpc) => {
          for (const k of (await trpc('apiKeys.list', undefined, false)).apiKeys ?? []) if (k.user_id === id || k.user_id === undefined) await trpc('apiKeys.delete', { uuid: k.uuid }).catch(() => {});
          for (const e of (await trpc('endpoints.list', undefined, false)).data) if (e.user_id === id) await trpc('endpoints.delete', { uuid: e.uuid });
          for (const n of (await trpc('namespaces.list', undefined, false)).data) if (n.user_id === id) await trpc('namespaces.delete', { uuid: n.uuid });
          for (const s of (await trpc('mcpServers.list', undefined, false)).data) if (s.user_id === id) await trpc('mcpServers.delete', { uuid: s.uuid });
        });
        state.restart = true;
        await this.#o.db.query('delete from users where id = $1', [id]); // cascades any remaining owned rows
        this.#o.log(`${username}: removed (not provisioned any more)`);
      }

      for (const c of clients) await this.#tripwire(c);
      this.#o.log(`ok: ${clients.map((c) => `${c.username}(${c.role}) tools ${c.tools?.total}, company ${c.tools?.company}`).join('; ')}`);
      return { status: 'ok', restartMetamcp: state.restart, users: clients.map(strip) };
    } catch (e) {
      this.#o.log(`FAILED: ${(e as Error).message}`);
      return { status: 'failed', error: (e as Error).message, restartMetamcp: state.restart, users: clients.map(strip) };
    }
  }

  async #withLogin<T>(username: string, fn: (trpc: Trpc, id: string) => Promise<T>): Promise<T> {
    const { db, baseUrl, origin, timeoutMs } = this.#o;
    const f = this.#o.fetch;
    const id = `${ID_PREFIX}${username}`;
    const email = `${username}@${EMAIL_DOMAIN}`;
    const password = randomBytes(32).toString('hex');
    await db.query(
      `insert into users (id, name, email, email_verified) values ($1, $2, $3, true)
       on conflict (id) do update set name = excluded.name, updated_at = now()`, [id, `Lokyy ${username}`, email]);
    await db.query('delete from accounts where user_id = $1', [id]);
    await db.query(`insert into accounts (id, account_id, provider_id, user_id, password) values ($1, $2, 'credential', $2, $3)`,
      [`${id}-credential`, id, await hashPassword(password)]);
    try {
      const res = await f(`${baseUrl}/api/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`sign-in as ${username} failed: ${res.status}`);
      const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const trpc: Trpc = async (proc, input, mutation = true) => {
        const url = mutation || input === undefined ? `${baseUrl}/trpc/frontend.${proc}`
          : `${baseUrl}/trpc/frontend.${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
        const r = await f(url, mutation
          ? { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}), signal: AbortSignal.timeout(timeoutMs) }
          : { headers: { cookie }, signal: AbortSignal.timeout(timeoutMs) });
        const body = await r.json() as { error?: { message?: string }; result: { data: { success?: boolean; message?: string } } };
        if (!r.ok || body.error) throw new Error(`${proc}: HTTP ${r.status} ${String(body.error?.message ?? 'error').slice(0, 200)}`);
        const data = body.result.data;
        if (data && data.success === false) throw new Error(`${proc}: ${data.message}`);
        return data;
      };
      return await fn(trpc, id);
    } finally {
      await db.query('delete from sessions where user_id = $1', [id]);
      await db.query('delete from accounts where user_id = $1', [id]);
    }
  }

  async #reconcileUser(u: UsersJson['users'][number], company: string, rotate: boolean, state: { restart: boolean }): Promise<Client> {
    const env = this.#o.env;
    return this.#withLogin(u.username, async (trpc, id) => {
      type TrpcRow = Awaited<ReturnType<Trpc>>;
      const own = (rows: TrpcRow[]): TrpcRow[] => rows.filter((r) => r.user_id === id);
      const reader = u.role === 'reader';
      const desired = [
        { name: `${u.username}-vault`, url: `http://mcp.vault-${u.vault}:4322/mcp`, bearerToken: token(env, u.vault),
          description: `Personal vault ${u.vault} (full access)` },
        { name: `${u.username}-${company}`, url: `http://mcp.vault-${company}:4322/mcp`, bearerToken: token(env, company, reader),
          description: `Company vault ${company} (${reader ? 'read-only token' : 'full access'})` },
      ];

      // Any change to credentials or server set of an existing user invalidates their key and open sessions.
      let changed = false;
      const servers = own((await trpc('mcpServers.list', undefined, false)).data);
      const serverUuids: string[] = [];
      for (const d of desired) {
        const existing = servers.find((s: { name: string }) => s.name === d.name);
        const fields = { ...d, type: 'STREAMABLE_HTTP', headers: {} };
        if (!existing) {
          serverUuids.push((await trpc('mcpServers.create', fields)).data.uuid);
          this.#o.log(`${u.username}: created server ${d.name}`);
        } else {
          if (existing.url !== d.url || existing.bearerToken !== d.bearerToken || existing.type !== 'STREAMABLE_HTTP') {
            await trpc('mcpServers.update', { uuid: existing.uuid, ...fields });
            changed = true;
            this.#o.log(`${u.username}: updated server ${d.name}`);
          }
          serverUuids.push(existing.uuid);
        }
      }
      for (const s of servers.filter((s: { name: string }) => !desired.some((d) => d.name === s.name))) {
        changed = true;
        await trpc('mcpServers.delete', { uuid: s.uuid });
        this.#o.log(`${u.username}: deleted stray server ${s.name}`);
      }

      const nsName = u.username;
      const namespaces = own((await trpc('namespaces.list', undefined, false)).data);
      let ns = namespaces.find((n: { name: string }) => n.name === nsName);
      if (!ns) {
        ns = (await trpc('namespaces.create', { name: nsName, description: `Lokyy ${u.role} ${u.username}`, mcpServerUuids: serverUuids })).data;
        this.#o.log(`${u.username}: created namespace`);
      } else {
        const current = ((await trpc('namespaces.get', { uuid: ns.uuid }, false)).data?.servers ?? []).map((s: { uuid: string }) => s.uuid).sort();
        if (JSON.stringify(current) !== JSON.stringify([...serverUuids].sort())) {
          await trpc('namespaces.update', { uuid: ns.uuid, name: nsName, description: `Lokyy ${u.role} ${u.username}`, mcpServerUuids: serverUuids });
          changed = true;
          this.#o.log(`${u.username}: updated namespace servers`);
        }
      }
      for (const n of namespaces.filter((n: { name: string }) => n.name !== nsName)) await trpc('namespaces.delete', { uuid: n.uuid });

      // endpoint: API key only, no OAuth, no key in query string, no self-registration as MCP server
      const epFlags = { enableApiKeyAuth: true, enableOauth: false, useQueryParamAuth: false };
      const endpoints = own((await trpc('endpoints.list', undefined, false)).data);
      const ep = endpoints.find((e: { name: string }) => e.name === u.username);
      if (!ep) {
        await trpc('endpoints.create', { name: u.username, namespaceUuid: ns.uuid, createMcpServer: false, ...epFlags });
        this.#o.log(`${u.username}: created endpoint`);
      } else if (ep.namespace_uuid !== ns.uuid || !ep.enable_api_key_auth || ep.enable_oauth || ep.use_query_param_auth) {
        await trpc('endpoints.update', { uuid: ep.uuid, name: u.username, namespaceUuid: ns.uuid, ...epFlags });
        changed = true;
        this.#o.log(`${u.username}: updated endpoint`);
      }
      for (const e of endpoints.filter((e: { name: string }) => e.name !== u.username)) await trpc('endpoints.delete', { uuid: e.uuid });

      const keys = ((await trpc('apiKeys.list', undefined, false)).apiKeys ?? []).filter((k: { user_id?: string }) => k.user_id === id || k.user_id === undefined);
      let key = keys.find((k: { name: string; is_active: boolean }) => k.name === KEY_NAME && k.is_active);
      const replace = rotate || changed;
      for (const k of keys.filter((k: unknown) => k !== key || replace)) {
        await trpc('apiKeys.delete', { uuid: k.uuid });
        this.#o.log(`${u.username}: deleted API key ${k.name}${rotate ? ' (rotation)' : changed ? ' (access changed)' : ''}`);
      }
      if (!key || replace) {
        key = await trpc('apiKeys.create', { name: KEY_NAME });
        this.#o.log(`${u.username}: issued API key`);
      }
      if (replace) state.restart = true;
      return { username: u.username, role: u.role, vault: u.vault, url: `${this.#o.publicBase}/metamcp/${u.username}/mcp`,
        apiKey: key.key, namespaceUuid: ns.uuid, companyServer: `${u.username}-${company}` };
    });
  }

  // The reader's company server holds the read-only token, so the vault exposes only read tools. As a
  // second layer, list the tools through the user's endpoint; any company tool outside the read list is
  // marked INACTIVE and the run fails loudly.
  async #mcpToolNames(url: string, apiKey: string): Promise<string[]> {
    const f = this.#o.fetch;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey };
    const post = async (body: unknown, sid?: string) => {
      const r = await f(url, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.#o.timeoutMs) });
      const t = await r.text();
      const line = t.split('\n').filter((l) => l.startsWith('data: ')).pop();
      return { r, msg: t ? JSON.parse(line ? line.slice(6) : t) : null };
    };
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lokyy-portal', version: '0' } } });
    const sid = init.r.headers.get('mcp-session-id');
    if (!sid) throw new Error(`no MCP session on ${url}: ${init.r.status}`);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    await f(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } }).catch(() => {});
    return ((list.msg?.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
  }

  async #tripwire(client: Client): Promise<void> {
    const names = await this.#mcpToolNames(`${this.#o.baseUrl}/metamcp/${client.username}/mcp`, client.apiKey);
    const prefix = `${client.companyServer}__`;
    const companyTools = names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
    const violations = companyTools.filter((n) => !READ_TOOLS.has(n));
    client.tools = { total: names.length, company: companyTools.length };
    if (client.role !== 'reader' || violations.length === 0) return;
    await this.#withLogin(client.username, async (trpc) => {
      await trpc('namespaces.refreshTools', { namespaceUuid: client.namespaceUuid,
        tools: violations.map((n) => ({ name: `${prefix}${n}`, inputSchema: {} })) });
      const tools = (await trpc('namespaces.getTools', { namespaceUuid: client.namespaceUuid }, false)).data ?? [];
      for (const t of tools.filter((t: { serverName: string; name: string }) => t.serverName === client.companyServer && violations.includes(t.name))) {
        await trpc('namespaces.updateToolStatus', { namespaceUuid: client.namespaceUuid, toolUuid: t.uuid, serverUuid: t.serverUuid, status: 'INACTIVE' });
      }
    });
    throw new Error(`${client.username}: company server exposes non-read tools (${violations.join(', ')}); marked INACTIVE in MetaMCP — fix the vault token`);
  }
}
