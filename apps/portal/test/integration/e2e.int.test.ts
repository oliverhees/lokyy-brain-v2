// Full path through the E2E stack (test/e2e/run.sh up && run.sh test): Traefik → Authentik forward-auth
// → portal → Authentik API / MetaMCP / vault config; employee accepts the invitation, logs in to the
// vault and lists MCP tools through mcp-gate. Skipped outside the stack.
import { describe, expect, it, vi } from 'vitest';
import { Browser, mcpTools, type Res } from './browser.ts';

const enabled = process.env['E2E'] === '1';
// Provisioning runs asynchronously in the watcher: steps wait for it.
vi.setConfig({ testTimeout: 120_000 });
const D = process.env['E2E_DOMAIN'] ?? 'portal.localhost';
const P = process.env['E2E_PUBLIC_PORT'] ?? '18380';
const site = (host: string) => `http://${host}.${D}:${P}`;
const APP = site('app');
const admin = { username: 'akadmin', password: process.env['AUTHENTIK_ADMIN_PASS'] ?? '' };
// Fixed name: on a reused stack the removed user gets their retired slot back, so runs repeat.
const user = 'e2e-anna';
const annaPass = `Pw-${Math.random().toString(36).slice(2)}-e2e-long`;

/** Polls fn until pred holds (the provisioning watcher works asynchronously). */
async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Waits until "Mein Zugang" reports the access as provisioned (poll /api/me, not the rate-limited reveal), then reveals the key. */
async function annaKey(b: Browser): Promise<string> {
  await until(async () => (await b.visit(`${APP}/api/me`)).json<{ provisioning: string }>(), (m) => m.provisioning === 'ok', 'provisioning ok');
  const session = (await b.visit(`${APP}/api/session`)).json<{ csrfToken: string }>();
  let r = await b.request(`${APP}/api/me/key/reveal`, { method: 'POST', headers: { 'x-csrf-token': session.csrfToken } });
  // Back-to-back runs share the per-user limit for key actions (10/min): honour Retry-After once.
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, (Number(r.headers['retry-after']) + 1) * 1000));
    r = await b.request(`${APP}/api/me/key/reveal`, { method: 'POST', headers: { 'x-csrf-token': session.csrfToken } });
  }
  expect(r.status).toBe(200);
  return r.json<{ apiKey: string }>().apiKey;
}

async function portalApi(b: Browser, method: string, path: string, body?: unknown): Promise<Res> {
  const session = (await b.visit(`${APP}/api/session`, admin)).json<{ csrfToken: string }>();
  return b.request(`${APP}${path}`, { method, body, headers: { 'x-csrf-token': session.csrfToken, accept: 'application/json' } });
}

describe.runIf(enabled)('E2E: invite → accept → vault login → MCP tools/list', () => {
  const adminB = new Browser();
  const annaB = new Browser();
  let link = '';
  let key = '';
  let slot = ''; // v01 on a fresh stack, or e2e-anna's retired slot

  it('admin logs in through Authentik and reaches the portal API as admin', async () => {
    const r = await adminB.visit(`${APP}/api/session`, admin);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ username: 'akadmin', isAdmin: true });
  });

  it('the vault config entrypoint is not reachable from the edge network', async () => {
    await expect(fetch('http://10.234.2.2:8090/v01/api/config', { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });

  it('the portal is not reachable without the proxy (forged identity headers are replaced)', async () => {
    const anon = new Browser();
    const r = await anon.request(`${APP}/api/session`, { headers: { 'x-authentik-username': 'akadmin', 'x-authentik-groups': 'lokyy-admins' } });
    expect(r.status).toBe(302); // forward-auth redirects to the login; nothing reaches the portal
  });

  it('setup: company name; EUrouter route lookup reaches the real API and rejects a fake key', async () => {
    expect((await portalApi(adminB, 'PUT', '/api/admin/setup/company', { name: 'E2E GmbH' })).status).toBe(204);
    const routes = await portalApi(adminB, 'POST', '/api/admin/setup/llm/routes', { apiKey: 'sk-e2e-not-a-real-key-1234' });
    expect(routes.status).toBe(400);
    expect(routes.json()).toMatchObject({ fields: { apiKey: 'invalid_key' } });
    // Without a route of a real key nothing reaches the vaults
    const llm = await portalApi(adminB, 'PUT', '/api/admin/setup/llm', { mode: 'shared', apiKey: 'sk-e2e-not-a-real-key-1234', ruleId: '00000000-0000-4000-8000-000000000000' });
    expect(llm.status).toBe(400);
    const setup = (await portalApi(adminB, 'GET', '/api/admin/setup')).json<{ package: string }>();
    expect(setup.package).toBe('e2e-2');
  });

  it('admin invites a reader: slot, Authentik groups, MetaMCP provisioning, invitation link', async () => {
    const r = await portalApi(adminB, 'POST', '/api/admin/users', { username: user, email: `${user}@example.com`, displayName: 'E2E Anna', role: 'reader' });
    expect(r.status).toBe(201);
    const body = r.json<{ user: { slot: string; provisioning: string }; inviteLink: string }>();
    expect(body.user.provisioning).toBe('pending');
    await until(async () => (await portalApi(adminB, 'GET', '/api/admin/users')).json<{ users: { username: string; provisioning: string }[] }>(),
      (l) => l.users.find((u) => u.username === user)?.provisioning === 'ok', 'watcher provisioning');
    slot = body.user.slot;
    expect(slot).toMatch(/^v0[12]$/);
    link = body.inviteLink;
    expect(link.startsWith(`${site('auth')}/if/flow/lokyy-set-password/?flow_token=`)).toBe(true);
  });

  it('the employee sets a password with the link and is logged in', async () => {
    const after = await annaB.visit(link, { username: user, password: annaPass, newPassword: annaPass });
    expect(after.status).toBeLessThan(400);
    // one-time link: a second use fails
    await expect(new Browser().visit(link, { username: user, password: 'x', newPassword: 'another-password-123' })).rejects.toThrow();
  });

  it('the employee sees "Mein Zugang" (and becomes active) and reveals the MCP key', async () => {
    const me = await annaB.visit(`${APP}/api/me`, { username: user, password: annaPass });
    expect(me.status).toBe(200);
    expect(me.json()).toMatchObject({ username: user, slot, vaultUrl: site(slot), companyVaultUrl: null, mcpUrl: `${site('mcp')}/metamcp/${user}/mcp` });
    expect(me.json()).toMatchObject({ provisioning: 'ok' });
    const session = (await annaB.visit(`${APP}/api/session`)).json<{ csrfToken: string; isAdmin: boolean }>();
    expect(session.isAdmin).toBe(false);
    expect((await annaB.request(`${APP}/api/admin/users`)).status).toBe(403);
    key = await annaKey(annaB);
    expect(key).toMatch(/^sk_mt_/);
  });

  it('vault access follows the groups: own vault yes, other slot and company web UI (reader) no', async () => {
    const own = await annaB.visit(`${site(slot)}/`, { username: user, password: annaPass });
    expect(own.status).toBe(200);
    expect(own.url.startsWith(site(slot))).toBe(true);
    expect(own.body).toContain('<title>MindBase');
    // Denied: Authentik answers its "access denied" page on the authorize URL; the vault is never reached.
    for (const host of [slot === 'v01' ? 'v02' : 'v01', 'firma']) {
      const denied = await annaB.visit(`${site(host)}/`, { username: user, password: annaPass });
      expect(denied.url.startsWith(site('auth'))).toBe(true);
      expect(denied.body).not.toContain('<title>MindBase');
    }
  });

  it('MCP through mcp-gate: own vault tools and read-only company tools', async () => {
    const tools = await mcpTools(annaB, `${site('mcp')}/metamcp/${user}/mcp`, key);
    expect(Array.isArray(tools)).toBe(true);
    const names = tools as string[];
    expect(names.some((n) => n.startsWith(`${user}-vault__`))).toBe(true);
    const company = names.filter((n) => n.startsWith(`${user}-firma__`));
    expect(company.length).toBeGreaterThan(0);
    expect(company.some((n) => /write|create|delete|ingest|update/.test(n))).toBe(false);
  });

  it('regenerate: the watcher issues a new key, the old one stops working', async () => {
    const session = (await annaB.visit(`${APP}/api/session`)).json<{ csrfToken: string }>();
    let rot = await annaB.request(`${APP}/api/me/key/rotate`, { method: 'POST', headers: { 'x-csrf-token': session.csrfToken } });
    if (rot.status === 429) {
      await new Promise((res) => setTimeout(res, (Number(rot.headers['retry-after']) + 1) * 1000));
      rot = await annaB.request(`${APP}/api/me/key/rotate`, { method: 'POST', headers: { 'x-csrf-token': session.csrfToken } });
    }
    expect(rot.status).toBe(202);
    const fresh = await annaKey(annaB);
    expect(fresh).not.toBe(key);
    expect(await mcpTools(annaB, `${site('mcp')}/metamcp/${user}/mcp`, key)).toBe(401);
    key = fresh;
    expect(Array.isArray(await mcpTools(annaB, `${site('mcp')}/metamcp/${user}/mcp`, key))).toBe(true);
  });

  it('role change to writer rotates the key: old key 401, new key sees company write tools', async () => {
    expect((await portalApi(adminB, 'PATCH', `/api/admin/users/${user}`, { role: 'writer' })).status).toBe(200);
    const old = key;
    key = await annaKey(annaB);
    expect(key).not.toBe(old);
    expect(await mcpTools(annaB, `${site('mcp')}/metamcp/${user}/mcp`, old)).toBe(401);
    const names = await mcpTools(annaB, `${site('mcp')}/metamcp/${user}/mcp`, key) as string[];
    expect(names.filter((n) => n.startsWith(`${user}-firma__`)).length).toBeGreaterThan(13);
  });

  it('disable: MCP key revoked and login refused', async () => {
    expect((await portalApi(adminB, 'POST', `/api/admin/users/${user}/disable`)).status).toBe(204);
    await until(() => mcpTools(new Browser(), `${site('mcp')}/metamcp/${user}/mcp`, key), (r) => r === 401, 'key revoked by the watcher');
    await expect(new Browser().visit(`${site(slot)}/`, { username: user, password: annaPass })).rejects.toThrow();
  });

  it('remove: data kept, slot blocked, audit trail written', async () => {
    const r = await portalApi(adminB, 'DELETE', `/api/admin/users/${user}`, { confirm: user, keepData: true });
    expect(r.status).toBe(204);
    const list = (await portalApi(adminB, 'GET', '/api/admin/users')).json<{ users: unknown[]; retired: { slot: string }[] }>();
    expect(list.retired.map((x) => x.slot)).toContain(slot);
    const audit = (await portalApi(adminB, 'GET', '/api/admin/audit')).json<{ entries: { action: string; target?: string }[] }>();
    for (const a of ['user.invite', 'user.role', 'user.disable', 'user.remove']) expect(audit.entries.some((e) => e.action === a && e.target === user)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(key);
  });
});
