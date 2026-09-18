import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashPasswordWithSalt, MetamcpProvisioner, validateUsersSpec, READ_TOOLS } from './metamcp.ts';
import { FakeMetamcp, ALL_TOOLS } from './fake-metamcp.ts';
import type { UsersJson } from '../../../src/server/slots.ts';

const tokens: Record<string, string> = {
  MCP_TOKEN_V01: 'tok-v01', MCP_TOKEN_V02: 'tok-v02', MCP_TOKEN_FIRMA: 'tok-firma', MCP_READONLY_TOKEN_FIRMA: 'tok-firma-ro',
};

const spec = (...users: [string, 'reader' | 'writer', string][]): UsersJson => ({
  companyVault: 'firma',
  generation: 0,
  users: users.map(([username, role, vault]) => ({ username, role, vault, allowVaultNameMismatch: true as const })),
});

let mm: FakeMetamcp;
let prov: MetamcpProvisioner;
beforeEach(() => {
  mm = new FakeMetamcp({ 'tok-v01': ALL_TOOLS, 'tok-v02': ALL_TOOLS, 'tok-firma': ALL_TOOLS, 'tok-firma-ro': [...READ_TOOLS] });
  prov = new MetamcpProvisioner({
    db: mm.db, baseUrl: 'http://metamcp:12008', publicBase: 'https://mcp.example.com', fetch: mm.fetch,
    env: tokens, log: () => {},
  });
});

describe('better-auth password hash', () => {
  it('matches a hash that better-auth 1.4.2 (MetaMCP 2.4.22) verifies', async () => {
    // Verified with better-auth/crypto verifyPassword inside ghcr.io/metatool-ai/metamcp:2.4.22.
    expect(await hashPasswordWithSalt('pw-Ü', '00112233445566778899aabbccddeeff')).toBe(
      '00112233445566778899aabbccddeeff:f59118ae48c1d63943e1468e19b2325cb1d0a93b5600c81fc9b6de8b365f75d1d711274b1b88db06adf33ef8402edb9cb3789e7a17489910b7d824ab26202ff4');
  });
  it('uses a fresh random salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('x'), hashPassword('x')]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });
});

describe('validateUsersSpec (rules of deploy/stack/metamcp/provision.mjs)', () => {
  const ok = spec(['anna', 'reader', 'v01']);
  it('accepts the portal format', () => {
    expect(() => validateUsersSpec(ok, tokens)).not.toThrow();
  });
  it.each([
    ['invalid username', spec(['Anna', 'reader', 'v01'])],
    ['vault must equal username', { companyVault: 'firma', generation: 0, users: [{ username: 'anna', role: 'reader', vault: 'v01' }] }],
    ['more than one user', spec(['anna', 'reader', 'v01'], ['ben', 'reader', 'v01'])],
    ['company vault', spec(['anna', 'reader', 'firma'])],
    ['role must be', spec(['anna', 'admin' as 'reader', 'v01'])],
    ['duplicate user', spec(['anna', 'reader', 'v01'], ['anna', 'reader', 'v02'])],
    ['MCP_TOKEN_V03 not set', spec(['anna', 'reader', 'v03'])],
  ])('rejects: %s', (msg, s) => {
    expect(() => validateUsersSpec(s as UsersJson, tokens)).toThrow(msg);
  });
  it('rejects a reader when the read-only company token is missing', () => {
    const { MCP_READONLY_TOKEN_FIRMA: _, ...rest } = tokens;
    expect(() => validateUsersSpec(ok, rest)).toThrow('MCP_READONLY_TOKEN_FIRMA');
  });
});

describe('MetamcpProvisioner.reconcile', () => {
  it('creates account, two servers, namespace, API-key-only endpoint and one key per user', async () => {
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v02']));
    expect(r.status).toBe('ok');
    expect(r.users.map((u) => [u.username, u.url])).toEqual([
      ['anna', 'https://mcp.example.com/metamcp/anna/mcp'], ['ben', 'https://mcp.example.com/metamcp/ben/mcp']]);
    const anna = mm.serversOf('lokyy-anna');
    expect(anna).toEqual([
      { name: 'anna-vault', url: 'http://mcp.vault-v01:4322/mcp', bearerToken: 'tok-v01' },
      { name: 'anna-firma', url: 'http://mcp.vault-firma:4322/mcp', bearerToken: 'tok-firma-ro' },
    ]);
    expect(mm.serversOf('lokyy-ben')[1]!.bearerToken).toBe('tok-firma');
    const ep = mm.endpoints.find((e) => e.name === 'anna')!;
    expect(ep).toMatchObject({ enable_api_key_auth: true, enable_oauth: false, use_query_param_auth: false, user_id: 'lokyy-anna' });
    expect(mm.apiKeys.filter((k) => k.user_id === 'lokyy-anna' && k.is_active)).toHaveLength(1);
    expect(r.users[0]!.tools).toEqual({ total: ALL_TOOLS.length + READ_TOOLS.size, company: READ_TOOLS.size });
  });

  it('leaves no way to log in as a provisioned account', async () => {
    await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(mm.accounts.size).toBe(0);
    expect(mm.sessions.size).toBe(0);
  });

  it('is idempotent: a second run changes nothing and keeps the key', async () => {
    await prov.reconcile(spec(['anna', 'reader', 'v01']));
    const key = await prov.readKey('anna');
    const before = mm.mutations.length;
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(r.restartMetamcp).toBe(false);
    expect(await prov.readKey('anna')).toBe(key);
    expect(mm.mutations.slice(before)).toEqual([]);
  });

  it('a role change swaps the company token, rotates the key and asks for a MetaMCP restart', async () => {
    await prov.reconcile(spec(['anna', 'reader', 'v01']));
    const before = await prov.readKey('anna');
    const r = await prov.reconcile(spec(['anna', 'writer', 'v01']));
    expect(mm.serversOf('lokyy-anna')[1]!.bearerToken).toBe('tok-firma');
    expect(await prov.readKey('anna')).not.toBe(before);
    expect(r.restartMetamcp).toBe(true);
  });

  it('rotates only the requested user', async () => {
    await prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v02']));
    const [a, b] = [await prov.readKey('anna'), await prov.readKey('ben')];
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v02']), { rotate: ['anna'] });
    expect(await prov.readKey('anna')).not.toBe(a);
    expect(await prov.readKey('ben')).toBe(b);
    expect(r.restartMetamcp).toBe(true);
  });

  it('removes users that are no longer listed, with all their objects', async () => {
    await prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v02']));
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(r.restartMetamcp).toBe(true);
    expect(mm.users.has('lokyy-ben')).toBe(false);
    expect(mm.serversOf('lokyy-ben')).toEqual([]);
    expect(mm.endpoints.some((e) => e.name === 'ben')).toBe(false);
    expect(await prov.readKey('ben')).toBeNull();
    expect(mm.users.has('lokyy-anna')).toBe(true);
  });

  it('never touches MetaMCP users outside the lokyy- prefix', async () => {
    mm.users.set('admin-1', { id: 'admin-1', name: 'Admin', email: 'admin@example.com' });
    await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(mm.users.has('admin-1')).toBe(true);
  });

  it('tripwire: a reader whose company server exposes write tools is marked INACTIVE and the run fails', async () => {
    mm.toolsByToken['tok-firma-ro'] = ALL_TOOLS; // misconfigured vault: read-only token grants everything
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/non-read tools/);
    expect(mm.inactiveTools.size).toBeGreaterThan(0);
    for (const t of mm.inactiveTools) expect(READ_TOOLS.has(t.split('__')[1]!)).toBe(false);
  });

  it('validates the whole spec before changing anything', async () => {
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v09']));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/MCP_TOKEN_V09/);
    expect(mm.mutations).toEqual([]);
    expect(mm.users.size).toBe(0);
  });

  it('reports a failure (status failed, error) instead of throwing, and says what exists', async () => {
    mm.failProc = 'endpoints.create';
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/endpoints.create/);
    expect(mm.accounts.size).toBe(0); // login removed even on failure
  });

  it('serialises concurrent runs', async () => {
    const runs = await Promise.all([
      prov.reconcile(spec(['anna', 'reader', 'v01'])),
      prov.reconcile(spec(['anna', 'reader', 'v01'], ['ben', 'writer', 'v02'])),
    ]);
    expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(mm.maxConcurrentLogins).toBe(1);
  });

  it('never returns API keys in the result', async () => {
    const r = await prov.reconcile(spec(['anna', 'reader', 'v01']));
    expect(JSON.stringify(r)).not.toContain(String(await prov.readKey('anna')));
  });
});
