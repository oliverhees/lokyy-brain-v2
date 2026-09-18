// Runs against the real authentik-gate and Authentik of the E2E stack (test/e2e/run.sh test); skipped otherwise.
// The portal only reaches Authentik through the gate; the bootstrap token is used here only to set up and
// inspect accounts the portal must not be able to touch.
import { afterAll, describe, expect, it } from 'vitest';
import { AuthentikGateClient, managedGroupsFor } from '../../src/server/authentik.ts';

const enabled = process.env['E2E'] === '1';
const env = (name: string) => process.env[name] ?? '';
const gateUrl = env('AUTHENTIK_GATE_URL');
const client = new AuthentikGateClient({ gateUrl, secret: env('AUTHENTIK_GATE_SECRET') });
const username = `int-${Date.now().toString(36)}`;
let pk: number | null = null;
const cleanup: number[] = [];

interface AkUser { pk: number; username: string; name: string; is_active: boolean; is_superuser: boolean; attributes: Record<string, unknown>; groups_obj: { name: string }[] }

/** Direct Authentik API with the bootstrap token (test setup and inspection only) */
async function ak<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${env('AUTHENTIK_URL')}/api/v3${path}`, {
    method, headers: { authorization: `Bearer ${env('AUTHENTIK_BOOTSTRAP_TOKEN')}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`bootstrap ${method} ${path}: ${r.status}`);
  return (r.status === 204 ? null : await r.json()) as T;
}
const akUser = (id: number) => ak<AkUser>('GET', `/core/users/${id}/`);
const akUserByName = async (name: string) => (await ak<{ results: AkUser[] }>('GET', `/core/users/?username=${encodeURIComponent(name)}`)).results[0]!;
const groupPk = async (name: string) => (await ak<{ results: { pk: string }[] }>('GET', `/core/groups/?name=${encodeURIComponent(name)}`)).results[0]!.pk;
const groupNames = (u: AkUser) => u.groups_obj.map((g) => g.name).sort();

/** Raw call to the gate, as a compromised portal could make it */
const gate = (method: string, path: string, body?: unknown, secret = env('AUTHENTIK_GATE_SECRET')) =>
  fetch(`${gateUrl}${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then((r) => r.status);

/** Every write the gate offers, against one target */
async function everyWrite(target: number): Promise<number[]> {
  return [
    await gate('PATCH', `/v1/users/${target}`, { isActive: false }),
    await gate('PATCH', `/v1/users/${target}`, { name: 'pwned', email: 'pwned@example.com' }),
    await gate('PATCH', `/v1/users/${target}`, { groups: ['lokyy-users'] }),
    await gate('POST', `/v1/users/${target}/recovery`, { tokenDuration: 'days=1' }),
    await gate('DELETE', `/v1/users/${target}/sessions`),
    await gate('DELETE', `/v1/users/${target}`),
  ];
}

afterAll(async () => {
  if (!enabled) return;
  if (pk !== null) await client.deleteUser(pk);
  for (const id of cleanup) await ak('DELETE', `/core/users/${id}/`).catch(() => {});
});

describe.runIf(enabled)('authentik-gate against Authentik 2026.8.2', () => {
  it('creates the portal user with the contract groups', async () => {
    pk = await client.ensureUser({ username, name: 'Int Test', email: `${username}@example.com`, slot: 'v02', groups: managedGroupsFor('v02', 'reader') });
    const u = await akUser(pk);
    expect(groupNames(u)).toEqual(['lokyy-users', 'vault-firma-read', 'vault-v02']);
    expect(u.attributes).toMatchObject({ lokyy_managed: true, lokyy_slot: 'v02' });
  });

  it('is idempotent and switches the role groups', async () => {
    const again = await client.ensureUser({ username, name: 'Int Test 2', email: `${username}@example.com`, slot: 'v02', groups: managedGroupsFor('v02', 'writer') });
    expect(again).toBe(pk);
    expect(groupNames(await akUser(pk!))).toEqual(['lokyy-users', 'vault-firma-write', 'vault-v02']);
  });

  it('refuses to adopt akadmin', async () => {
    await expect(client.ensureUser({ username: 'akadmin', name: 'x', email: 'x@example.com', slot: 'v01', groups: [] }))
      .rejects.toMatchObject({ code: 'username_taken' });
  });

  it('issues an invitation link into the set-password flow', async () => {
    const link = await client.inviteLink(pk!, 'days=7');
    expect(link).toContain('/if/flow/lokyy-set-password/');
    expect(link).toContain('flow_token=');
  });

  it('deactivates, ends sessions and reactivates', async () => {
    await client.setActive(pk!, false);
    await client.endSessions(pk!);
    expect((await akUser(pk!)).is_active).toBe(false);
    await client.setActive(pk!, true);
    expect((await akUser(pk!)).is_active).toBe(true);
  });

  it('there is only ever one invitation link per user: resend re-issues the same token with a new expiry', async () => {
    // Authentik keeps one recovery FlowToken per user (update_or_create on "<uid>-password-reset").
    const a = await client.inviteLink(pk!, 'days=1');
    const b = await client.inviteLink(pk!, 'days=1');
    expect(b).toBe(a);
  });

  it('the gate refuses every write on akadmin; akadmin stays active, superuser and unchanged', async () => {
    const admin = await akUserByName('akadmin');
    expect(await everyWrite(admin.pk)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(await gate('POST', `/v1/users/${admin.pk}/set_password`, { password: 'x'.repeat(20) })).toBe(404);
    const after = await akUser(admin.pk);
    expect(after).toMatchObject({ is_active: true, is_superuser: true, username: 'akadmin', name: admin.name });
    expect(groupNames(after)).toEqual(groupNames(admin));
  });

  it('the gate refuses every write on a lokyy-admins member, even one marked as portal-managed', async () => {
    const chef = await ak<AkUser>('POST', '/core/users/', {
      username: `${username}-chef`, name: 'Chef', path: 'lokyy', is_active: true,
      attributes: { lokyy_managed: true, lokyy_slot: 'v01' }, groups: [await groupPk('lokyy-admins')],
    });
    cleanup.push(chef.pk);
    expect(await everyWrite(chef.pk)).toEqual([403, 403, 403, 403, 403, 403]);
    const after = await akUser(chef.pk);
    expect(after).toMatchObject({ is_active: true, name: 'Chef' });
    expect(groupNames(after)).toEqual(['lokyy-admins']);
  });

  it('an employee made admin by hand is out of the portal\'s reach from then on', async () => {
    const own = await ak<AkUser>('PATCH', `/core/users/${pk}/`, { groups: [await groupPk('lokyy-admins')] });
    expect(groupNames(own)).toEqual(['lokyy-admins']);
    await expect(client.setActive(pk!, false)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await akUser(pk!)).is_active).toBe(true);
    await ak('PATCH', `/core/users/${pk}/`, { groups: [] }); // back to a plain managed user for cleanup
  });

  it('never grants admin groups, never passes raw API calls through, and wants its secret', async () => {
    expect(await gate('PATCH', `/v1/users/${pk}`, { groups: ['lokyy-admins'] })).toBe(400);
    expect(await gate('PATCH', `/v1/users/${pk}`, { groups: ['authentik Admins'] })).toBe(400);
    expect(await gate('PATCH', `/v1/users/${pk}`, { is_superuser: true })).toBe(400);
    expect(await gate('POST', `/v1/users/${pk}/set_password`, { password: 'x'.repeat(20) })).toBe(404);
    expect(await gate('GET', '/api/v3/core/users/')).toBe(404);
    expect(await gate('GET', '/v1/users', undefined, 'x'.repeat(64))).toBe(401);
    expect(groupNames(await akUser(pk!))).toEqual([]);
  });

  it('the token the gate holds is least privilege as well: no superuser group, no other tokens', async () => {
    // Defence in depth behind the gate: the service-account token itself cannot escalate.
    const base = env('AUTHENTIK_URL');
    const auth = { authorization: `Bearer ${env('AUTHENTIK_API_TOKEN')}`, 'content-type': 'application/json' };
    const su = await groupPk('authentik Admins');
    const patch = await fetch(`${base}/api/v3/core/users/${pk}/`, { method: 'PATCH', headers: auth, body: JSON.stringify({ groups: [su] }) });
    expect(patch.status).toBe(400);
    const tokens = await (await fetch(`${base}/api/v3/core/tokens/`, { headers: auth })).json() as { results: { identifier: string }[] };
    expect(tokens.results.map((t) => t.identifier)).toEqual(['lokyy-portal-api']);
    expect((await fetch(`${base}/api/v3/providers/proxy/`, { headers: auth })).status).toBe(403);
    expect((await fetch(`${base}/api/v3/rbac/roles/`, { headers: auth })).status).toBe(403);
  });

  it('reports a missing group', async () => {
    await expect(client.setGroups(pk!, ['vault-v99'])).rejects.toMatchObject({ code: 'group_missing' });
  });
});
