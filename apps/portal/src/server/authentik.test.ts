import { beforeEach, describe, expect, it } from 'vitest';
import { AuthentikClient, AuthentikError, managedGroupsFor } from './authentik.ts';
import { FakeAuthentik } from '../../test/fakes/authentik.ts';

let ak: FakeAuthentik;
let client: AuthentikClient;
beforeEach(() => {
  ak = new FakeAuthentik(['vault-v01', 'vault-v02', 'vault-firma-read', 'vault-firma-write', 'lokyy-admins']);
  client = new AuthentikClient({ baseUrl: 'http://authentik-server:9000', token: 'tok-secret', fetch: ak.fetch });
});

describe('managedGroupsFor', () => {
  it('maps slot and role to the Authentik groups of the contract', () => {
    expect(managedGroupsFor('v01', 'reader')).toEqual(['vault-v01', 'vault-firma-read']);
    expect(managedGroupsFor('v02', 'writer')).toEqual(['vault-v02', 'vault-firma-write']);
  });
});

describe('AuthentikClient', () => {
  it('sends the API token as bearer and never in the URL', async () => {
    await client.ensureUser({ username: 'anna', name: 'Anna', email: 'anna@example.com', slot: 'v01', groups: ['vault-v01'] });
    expect(ak.requests.length).toBeGreaterThan(0);
    for (const r of ak.requests) {
      expect(r.headers['authorization']).toBe('Bearer tok-secret');
      expect(r.url).not.toContain('tok-secret');
    }
  });

  it('creates a portal-managed user with slot attribute and groups', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'Anna A', email: 'anna@example.com', slot: 'v01', groups: ['vault-v01', 'vault-firma-read'] });
    const u = ak.users.get(pk)!;
    expect(u).toMatchObject({ username: 'anna', name: 'Anna A', email: 'anna@example.com', is_active: true, path: 'lokyy' });
    expect(u.attributes).toEqual({ lokyy_managed: true, lokyy_slot: 'v01' });
    expect(ak.groupNamesOf(pk)).toEqual(['vault-firma-read', 'vault-v01']);
  });

  it('is idempotent and updates name, email and groups of its own user', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'Anna', email: 'a@example.com', slot: 'v01', groups: ['vault-v01', 'vault-firma-read'] });
    const again = await client.ensureUser({ username: 'anna', name: 'Anna B', email: 'b@example.com', slot: 'v01', groups: ['vault-v01', 'vault-firma-write'] });
    expect(again).toBe(pk);
    expect(ak.users.size).toBe(1);
    expect(ak.users.get(pk)).toMatchObject({ name: 'Anna B', email: 'b@example.com' });
    expect(ak.groupNamesOf(pk)).toEqual(['vault-firma-write', 'vault-v01']);
  });

  it('refuses to take over a user it did not create (e.g. akadmin or a hand-made account)', async () => {
    ak.addUser({ username: 'boss', attributes: {} });
    await expect(client.ensureUser({ username: 'boss', name: 'B', email: 'b@example.com', slot: 'v01', groups: [] }))
      .rejects.toMatchObject({ code: 'username_taken' });
  });

  it('refuses a portal user that belongs to another slot', async () => {
    ak.addUser({ username: 'anna', attributes: { lokyy_managed: true, lokyy_slot: 'v02' } });
    await expect(client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] }))
      .rejects.toMatchObject({ code: 'username_taken' });
  });

  it('keeps groups the portal does not manage (lokyy-admins) when changing vault groups', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: ['vault-v01', 'vault-firma-read'] });
    ak.addToGroup(pk, 'lokyy-admins');
    await client.setGroups(pk, ['vault-v01', 'vault-firma-write']);
    expect(ak.groupNamesOf(pk)).toEqual(['lokyy-admins', 'vault-firma-write', 'vault-v01']);
    await client.setGroups(pk, []);
    expect(ak.groupNamesOf(pk)).toEqual(['lokyy-admins']);
  });

  it('fails loudly when a group of the contract is missing in Authentik', async () => {
    await expect(client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v09', groups: ['vault-v09'] }))
      .rejects.toMatchObject({ code: 'group_missing' });
  });

  it('creates an invitation (recovery) link with the requested validity', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] });
    const link = await client.inviteLink(pk, 'days=7');
    expect(link).toMatch(/^https:\/\/auth\.example\.com\/if\/flow\/lokyy-set-password\/\?flow_token=/);
    expect(ak.recoveryRequests).toEqual([{ pk, token_duration: 'days=7' }]);
  });

  it('rewrites the link to the public Authentik URL (the API is called on the internal host)', async () => {
    const pub = new AuthentikClient({ baseUrl: 'http://authentik-server:9000', publicUrl: 'https://auth.firma.de/', token: 'tok-secret', fetch: ak.fetch });
    const pk = await pub.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] });
    expect(await pub.inviteLink(pk, 'days=7')).toBe(`https://auth.firma.de/if/flow/lokyy-set-password/?flow_token=tok${pk}`);
  });

  it('reports a missing recovery flow as its own error code', async () => {
    ak.recoveryFlowSet = false;
    const pk = await client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] });
    await expect(client.inviteLink(pk, 'days=7')).rejects.toMatchObject({ code: 'no_recovery_flow' });
  });

  it('deactivates a user and ends their sessions', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] });
    ak.sessions.push({ uuid: 's1', username: 'anna' }, { uuid: 's2', username: 'ben' });
    await client.setActive(pk, false);
    await client.endSessions('anna');
    expect(ak.users.get(pk)!.is_active).toBe(false);
    expect(ak.sessions.map((s) => s.uuid)).toEqual(['s2']);
  });

  it('deletes a user; deleting a missing user is not an error', async () => {
    const pk = await client.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] });
    await client.deleteUser(pk);
    expect(ak.users.size).toBe(0);
    await expect(client.deleteUser(pk)).resolves.toBeUndefined();
  });

  it('turns HTTP errors into AuthentikError without leaking the token or response body', async () => {
    ak.failNext = { status: 500, body: 'internal tok-secret detail' };
    const err = await client.findUser('anna').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthentikError);
    expect(String((err as Error).message)).not.toContain('tok-secret');
    expect((err as AuthentikError).status).toBe(500);
  });

  it('finds users by exact username only', async () => {
    ak.addUser({ username: 'anna2', attributes: {} });
    expect(await client.findUser('anna')).toBeNull();
    expect((await client.findUser('anna2'))?.username).toBe('anna2');
  });
});
