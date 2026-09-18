// Runs against the real Authentik of the E2E stack (test/e2e/run.sh test); skipped otherwise.
import { afterAll, describe, expect, it } from 'vitest';
import { AuthentikClient, managedGroupsFor } from '../../src/server/authentik.ts';

const enabled = process.env['E2E'] === '1';
const client = new AuthentikClient({ baseUrl: process.env['AUTHENTIK_URL'] ?? '', token: process.env['AUTHENTIK_API_TOKEN'] ?? '' });
const username = `int-${Date.now().toString(36)}`;
let pk: number | null = null;

afterAll(async () => {
  if (enabled && pk !== null) await client.deleteUser(pk);
});

describe.runIf(enabled)('AuthentikClient against Authentik 2026.8.2', () => {
  it('creates the portal user with the contract groups', async () => {
    pk = await client.ensureUser({ username, name: 'Int Test', email: `${username}@example.com`, slot: 'v02', groups: managedGroupsFor('v02', 'reader') });
    const u = await client.getUser(pk);
    expect(u?.groups.map((g) => g.name).sort()).toEqual(['vault-firma-read', 'vault-v02']);
    expect(u?.attributes).toMatchObject({ lokyy_managed: true, lokyy_slot: 'v02' });
  });

  it('is idempotent and switches the role groups', async () => {
    const again = await client.ensureUser({ username, name: 'Int Test 2', email: `${username}@example.com`, slot: 'v02', groups: managedGroupsFor('v02', 'writer') });
    expect(again).toBe(pk);
    expect((await client.getUser(pk!))?.groups.map((g) => g.name).sort()).toEqual(['vault-firma-write', 'vault-v02']);
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
    await client.endSessions(username);
    expect((await client.getUser(pk!))?.isActive).toBe(false);
    await client.setActive(pk!, true);
    expect((await client.getUser(pk!))?.isActive).toBe(true);
  });

  it('reports a missing group', async () => {
    await expect(client.setGroups(pk!, ['vault-v99'])).rejects.toMatchObject({ code: 'group_missing' });
  });
});
