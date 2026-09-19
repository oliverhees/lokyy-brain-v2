// LBV2-4 — MetaMCP provisioning, executed inside the metamcp container by provision.sh
// (stdin module, cwd /app/apps/backend so pg and better-auth resolve from MetaMCP's own deps).
//
// Why one MetaMCP account per user: MetaMCP 2.4.22 binds API keys to endpoints by owner
// (checkApiKeyAccess: key.user_id must equal endpoint.user_id; public keys cannot open private
// endpoints, but ANY key opens a public endpoint). Per-user ownership is the only way to make
// anna's key useless on ben's endpoint. Those accounts are created with a random one-time
// password, used for the API calls of this run, and their credential account + sessions are
// deleted again at the end — nobody can log in as them.
//
// Logs go to stderr; stdout is the JSON handed to users (written to secrets/ by provision.sh).
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(`${process.cwd()}/`);
const { Client } = require('pg');
const { hashPassword } = await import(require.resolve('better-auth/crypto'));

const BASE = 'http://localhost:12008';
const ID_PREFIX = 'lokyy-';
const EMAIL_DOMAIN = 'users.lokyy.local';
const KEY_NAME = 'lokyy';
// Mirror of READ_ONLY_TOOL_NAMES in apps/mcp/src/access.ts (tests/metamcp-attacks.sh checks they match).
const READ_TOOLS = new Set(['search_wiki', 'search_all_projects', 'search_in_project', 'read_wiki_page', 'list_recent',
  'find_related', 'get_graph_insights', 'find_orphans', 'suggest_links', 'export_subgraph', 'list_feeds', 'list_review_cards', 'ask_wiki']);

const log = (...a) => console.error('[provision]', ...a);
const fail = (msg) => { throw new Error(msg); };

// ------------------------------------------------------------------ input
const spec = JSON.parse(process.env.LOKYY_USERS ?? fail('LOKYY_USERS missing'));
const rotateList = JSON.parse(process.env.LOKYY_ROTATE ?? "[]");
const rotateAll = rotateList.includes("*");
const rotate = { has: (u) => rotateAll || rotateList.includes(u) };
const publicBase = process.env.LOKYY_PUBLIC_BASE;
const VAULT_RE = /^[a-z][a-z0-9-]{0,30}$/;
const company = spec.companyVault ?? fail('companyVault missing');
if (typeof company !== 'string' || !VAULT_RE.test(company)) fail('invalid companyVault');
const token = (vault, readonly = false) => {
  const name = `MCP_${readonly ? 'READONLY_' : ''}TOKEN_${vault.toUpperCase().replace(/-/g, '_')}`;
  return process.env[name] || fail(`${name} not set`);
};
if (!Array.isArray(spec.users)) fail('users must be an array');
// Input is validated as a whole before anything changes: an invalid users file is refused and changes
// nothing (tests/metamcp-attacks.sh "refused runs"). Runtime failures later are per user (see main).
const seen = new Set();
const vaultsSeen = new Set();
const users = [];
const failed = [];
for (const u of spec.users) {
  if (typeof u.username !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(u.username) || u.username.includes('--')) fail(`invalid username: ${u.username}`);
  if (typeof u.vault !== 'string' || !VAULT_RE.test(u.vault)) fail(`invalid vault for ${u.username}`);
  // A personal vault belongs to exactly one user and carries that user's name, unless explicitly allowed.
  if (u.vault !== u.username && u.allowVaultNameMismatch !== true) fail(`${u.username}: vault must equal username (set "allowVaultNameMismatch": true to override)`);
  if (vaultsSeen.has(u.vault)) fail(`vault ${u.vault} assigned to more than one user`);
  vaultsSeen.add(u.vault);
  if (u.vault === company) fail(`${u.username}: own vault must not be the company vault`);
  if (!['reader', 'writer'].includes(u.role)) fail(`${u.username}: role must be reader or writer`);
  if (seen.has(u.username)) fail(`duplicate user ${u.username}`);
  seen.add(u.username);
  token(u.vault); token(company, u.role === 'reader');
  users.push(u);
}
for (const r of rotateList) if (r !== "*" && !seen.has(r)) fail(`--rotate ${r}: not in users file`);

// ------------------------------------------------------------------ db + session
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function withLogin(username, fn) {
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
    const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) fail(`sign-in as ${username} failed: ${res.status}`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const trpc = async (proc, input, mutation = true) => {
      const url = mutation || input === undefined ? `${BASE}/trpc/frontend.${proc}`
        : `${BASE}/trpc/frontend.${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
      const r = await fetch(url, mutation
        ? { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) }
        : { headers: { cookie } });
      const body = await r.json();
      if (!r.ok || body.error) fail(`${proc}: HTTP ${r.status} ${String(body.error?.message ?? 'error').slice(0, 200)}`);
      const data = body.result.data;
      if (data && data.success === false) fail(`${proc}: ${data.message}`);
      return data;
    };
    return await fn({ id, trpc });
  } finally {
    await db.query('delete from sessions where user_id = $1', [id]);
    await db.query('delete from accounts where user_id = $1', [id]);
  }
}

// ------------------------------------------------------------------ reconcile one user
async function reconcile(u) {
  return withLogin(u.username, async ({ id, trpc }) => {
    const own = (rows) => rows.filter((r) => r.user_id === id);
    const reader = u.role === 'reader';
    const desired = [
      { name: `${u.username}-vault`, url: `http://mcp.vault-${u.vault}:4322/mcp`, bearerToken: token(u.vault),
        description: `Personal vault ${u.vault} (full access)` },
      { name: `${u.username}-${company}`, url: `http://mcp.vault-${company}:4322/mcp`, bearerToken: token(company, reader),
        description: `Company vault ${company} (${reader ? 'read-only token' : 'full access'})` },
    ];

    // Any change to credentials or server set of an existing user invalidates their key and open sessions (M1).
    let changed = false;
    // servers
    const servers = own((await trpc('mcpServers.list', undefined, false)).data);
    const serverUuids = [];
    for (const d of desired) {
      const existing = servers.find((s) => s.name === d.name);
      const fields = { ...d, type: 'STREAMABLE_HTTP', headers: {} };
      if (!existing) {
        serverUuids.push((await trpc('mcpServers.create', fields)).data.uuid);
        log(`${u.username}: created server ${d.name}`);
      } else {
        if (existing.url !== d.url || existing.bearerToken !== d.bearerToken || existing.type !== 'STREAMABLE_HTTP') {
          await trpc('mcpServers.update', { uuid: existing.uuid, ...fields });
          changed = true;
          log(`${u.username}: updated server ${d.name}`);
        }
        serverUuids.push(existing.uuid);
      }
    }
    for (const s of servers.filter((s) => !desired.some((d) => d.name === s.name))) {
      changed = true;
      await trpc('mcpServers.delete', { uuid: s.uuid });
      log(`${u.username}: deleted stray server ${s.name}`);
    }

    // namespace
    const nsName = u.username;
    const namespaces = own((await trpc('namespaces.list', undefined, false)).data);
    let ns = namespaces.find((n) => n.name === nsName);
    if (!ns) {
      ns = (await trpc('namespaces.create', { name: nsName, description: `Lokyy ${u.role} ${u.username}`, mcpServerUuids: serverUuids })).data;
      log(`${u.username}: created namespace`);
    } else {
      const current = ((await trpc('namespaces.get', { uuid: ns.uuid }, false)).data?.servers ?? []).map((s) => s.uuid).sort();
      if (JSON.stringify(current) !== JSON.stringify([...serverUuids].sort())) {
        await trpc('namespaces.update', { uuid: ns.uuid, name: nsName, description: `Lokyy ${u.role} ${u.username}`, mcpServerUuids: serverUuids });
        changed = true;
        log(`${u.username}: updated namespace servers`);
      }
    }
    for (const n of namespaces.filter((n) => n.name !== nsName)) await trpc('namespaces.delete', { uuid: n.uuid });

    // endpoint: API key only, no OAuth, no key in query string, no self-registration as MCP server
    const epFlags = { enableApiKeyAuth: true, enableOauth: false, useQueryParamAuth: false };
    const endpoints = own((await trpc('endpoints.list', undefined, false)).data);
    const ep = endpoints.find((e) => e.name === u.username);
    if (!ep) {
      await trpc('endpoints.create', { name: u.username, namespaceUuid: ns.uuid, createMcpServer: false, ...epFlags });
      log(`${u.username}: created endpoint`);
    } else if (ep.namespace_uuid !== ns.uuid || !ep.enable_api_key_auth || ep.enable_oauth || ep.use_query_param_auth) {
      await trpc('endpoints.update', { uuid: ep.uuid, name: u.username, namespaceUuid: ns.uuid, ...epFlags });
      changed = true;
      log(`${u.username}: updated endpoint`);
    }
    for (const e of endpoints.filter((e) => e.name !== u.username)) await trpc('endpoints.delete', { uuid: e.uuid });

    // api key
    const keys = ((await trpc('apiKeys.list', undefined, false)).apiKeys ?? []).filter((k) => k.user_id === id || k.user_id === undefined);
    let key = keys.find((k) => k.name === KEY_NAME && k.is_active);
    for (const k of keys.filter((k) => k !== key || (rotate.has(u.username) || changed))) {
      await trpc('apiKeys.delete', { uuid: k.uuid });
      log(`${u.username}: deleted API key ${k.name}${rotate.has(u.username) ? " (rotation)" : changed ? " (access changed)" : ""}`);
    }
    if (!key || (rotate.has(u.username) || changed)) {
      key = await trpc('apiKeys.create', { name: KEY_NAME });
      log(`${u.username}: issued API key`);
    }
    // A rotated key also ends every open session (MetaMCP and gate keep sessions of the old key otherwise).
    if (changed || rotate.has(u.username)) restartMetamcp = true;
    return { username: u.username, role: u.role, vault: u.vault, companyVault: company,
      url: `${publicBase}/metamcp/${u.username}/mcp`, apiKey: key.key, namespaceUuid: ns.uuid, companyServer: `${u.username}-${company}` };
  });
}

// ------------------------------------------------------------------ second layer (reader tripwire)
// The reader's company server holds the read-only token, so the vault exposes only read tools and
// MetaMCP has nothing to deactivate. MetaMCP deletes tools a server no longer lists, so write tools
// cannot be pre-deactivated either. Instead: list the tools through the user's endpoint; any
// company tool outside the read allowlist is marked INACTIVE and the run fails loudly.
async function mcpToolNames(url, apiKey) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey };
  const post = async (body, sid) => {
    const r = await fetch(url, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const t = await r.text();
    const line = t.split('\n').filter((l) => l.startsWith('data: ')).pop();
    return { r, msg: t ? JSON.parse(line ? line.slice(6) : t) : null };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'provision', version: '0' } } });
  const sid = init.r.headers.get('mcp-session-id') ?? fail(`no MCP session on ${url}: ${init.r.status}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
  await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } }).catch(() => {});
  return (list.msg?.result?.tools ?? []).map((t) => t.name);
}

async function tripwire(client) {
  const names = await mcpToolNames(`${BASE}/metamcp/${client.username}/mcp`, client.apiKey);
  const prefix = `${client.companyServer}__`;
  const companyTools = names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
  const violations = companyTools.filter((n) => !READ_TOOLS.has(n));
  client.tools = { total: names.length, company: companyTools.length };
  if (client.role !== 'reader' || violations.length === 0) return;
  // LOW-C: first revoke every key of this reader (the existing one and one issued in this run), directly in the
  // database so nothing later in this function can prevent it; open sessions end with the MetaMCP restart.
  await db.query('delete from api_keys where user_id = $1', [`${ID_PREFIX}${client.username}`]);
  restartMetamcp = true;
  await withLogin(client.username, async ({ trpc }) => {
    await trpc('namespaces.refreshTools', { namespaceUuid: client.namespaceUuid,
      tools: violations.map((n) => ({ name: `${prefix}${n}`, inputSchema: {} })) });
    const tools = (await trpc('namespaces.getTools', { namespaceUuid: client.namespaceUuid }, false)).data ?? [];
    for (const t of tools.filter((t) => t.serverName === client.companyServer && violations.includes(t.name))) {
      await trpc('namespaces.updateToolStatus', { namespaceUuid: client.namespaceUuid, toolUuid: t.uuid, serverUuid: t.serverUuid, status: 'INACTIVE' });
    }
  });
  fail(`${client.username}: company server exposes non-read tools (${violations.join(', ')}); marked INACTIVE in MetaMCP and API keys revoked — fix the vault token`);
}

// ------------------------------------------------------------------ main
// Set when open MetaMCP sessions may carry outdated access (changed or removed user): the caller restarts MetaMCP.
let restartMetamcp = false;
const removed = [];
const clients = [];
// LBV2-27: revocations first and each on its own, so a failing user can never delay or block removing access
// of another; then every listed user independently. Every user ends up "ok" (with key) or "failed".
async function revoke(id) {
  const username = id.slice(ID_PREFIX.length);
  // Delete what the account owns directly (no login needed), then the account; sessions die with the restart.
  await db.query('delete from api_keys where user_id = $1', [id]).catch(() => {});
  await withLogin(username, async ({ trpc }) => {
    for (const k of (await trpc('apiKeys.list', undefined, false)).apiKeys ?? []) if (k.user_id === id || k.user_id === undefined) await trpc('apiKeys.delete', { uuid: k.uuid }).catch(() => {});
    for (const e of (await trpc('endpoints.list', undefined, false)).data) if (e.user_id === id) await trpc('endpoints.delete', { uuid: e.uuid });
    for (const n of (await trpc('namespaces.list', undefined, false)).data) if (n.user_id === id) await trpc('namespaces.delete', { uuid: n.uuid });
    for (const s of (await trpc('mcpServers.list', undefined, false)).data) if (s.user_id === id) await trpc('mcpServers.delete', { uuid: s.uuid });
  }).catch((e) => log(`${username}: cleanup via API failed (${e.message}); deleting the account directly`));
  await db.query('delete from users where id = $1', [id]); // cascades any remaining owned rows
}
let fatal = null;
try {
  const listed = new Set(users.map((u) => `${ID_PREFIX}${u.username}`));
  const { rows } = await db.query('select id from users where id like $1', [`${ID_PREFIX}%`]);
  for (const { id } of rows.filter((r) => !listed.has(r.id))) {
    const username = id.slice(ID_PREFIX.length);
    try {
      await revoke(id);
      restartMetamcp = true;
      removed.push(username);
      log(`${username}: removed (not in users file)`);
    } catch (e) {
      restartMetamcp = true; // whatever was deleted may already have changed live sessions
      log(`${username}: REMOVAL FAILED: ${e.message}`);
      fatal ??= `removal of ${username} failed: ${e.message}`;
    }
  }
  for (const u of users) {
    try {
      const c = await reconcile(u);
      await tripwire(c);
      delete c.namespaceUuid;
      clients.push({ ...c, status: 'ok' });
    } catch (e) {
      // No key is handed out for a user whose run failed (a reader with write tools, half-updated servers)
      log(`${u.username}: FAILED: ${e.message}`);
      failed.push({ username: u.username, role: u.role, vault: u.vault, status: 'failed', error: e.message });
    }
  }
} catch (e) {
  fatal = e.message;
} finally {
  await db.end();
}
const status = fatal || failed.length ? 'failed' : 'ok';
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), status, ...(fatal ? { error: fatal } : {}), restartMetamcp,
  removed, users: [...clients, ...failed] }, null, 2));
log(`${status}: ${clients.map((c) => `${c.username}(${c.role}) tools ${c.tools.total}, company ${c.tools.company}`).join('; ')}${failed.length ? `; failed: ${failed.map((f) => f.username).join(', ')}` : ''}${removed.length ? `; removed: ${removed.join(', ')}` : ''}`);
if (status !== 'ok') process.exitCode = 1;
