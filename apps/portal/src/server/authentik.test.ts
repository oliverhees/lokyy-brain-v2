import { beforeEach, describe, expect, it } from 'vitest';
import { AuthentikGateClient, AuthentikError, managedGroupsFor } from './authentik.ts';
import { FakeAuthentik } from '../../test/fakes/authentik.ts';
import { fakeGate, GATE_SECRET, GATE_URL, type FakeGate } from '../../test/fakes/gate.ts';

let ak: FakeAuthentik;
let gate: FakeGate;
let client: AuthentikGateClient;
beforeEach(() => {
  ak = new FakeAuthentik(['vault-v01', 'vault-v02', 'vault-firma-read', 'vault-firma-write', 'lokyy-admins', 'lokyy-users', 'authentik Admins', 'some-team']);
  gate = fakeGate(ak);
  client = new AuthentikGateClient({ gateUrl: GATE_URL, secret: GATE_SECRET, fetch: gate.fetch });
});

const anna = (o: Partial<{ slot: string; groups: string[]; name: string; email: string }> = {}) =>
  client.ensureUser({ username: 'anna', name: 'Anna', email: 'anna@example.com', slot: 'v01', groups: ['vault-v01', 'vault-firma-read'], ...o });

describe('managedGroupsFor', () => {
  it('maps slot and role to the Authentik groups of the contract (lokyy-users admits to the portal)', () => {
    expect(managedGroupsFor('v01', 'reader')).toEqual(['vault-v01', 'vault-firma-read', 'lokyy-users']);
    expect(managedGroupsFor('v02', 'writer')).toEqual(['vault-v02', 'vault-firma-write', 'lokyy-users']);
  });
});

describe('AuthentikGateClient', () => {
  it('audit LOW: only user_not_found counts as "already gone"; a 404 for an unknown gate route throws (version skew)', async () => {
    await expect(client.endSessions(999999)).resolves.toBeUndefined();
    await expect(client.deleteUser(999999)).resolves.toBeUndefined();
    const oldGate = new AuthentikGateClient({ gateUrl: GATE_URL, secret: GATE_SECRET,
      fetch: async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }) });
    await expect(oldGate.endSessions(1)).rejects.toBeInstanceOf(AuthentikError);
    await expect(oldGate.deleteUser(1)).rejects.toBeInstanceOf(AuthentikError);
  });

  it('talks only to the gate, with the gate secret as bearer and never in the URL', async () => {
    await anna();
    expect(gate.requests.length).toBeGreaterThan(0);
    for (const r of gate.requests) {
      expect(r.url.startsWith(`${GATE_URL}/v1/`)).toBe(true);
      expect(r.authorization).toBe(`Bearer ${GATE_SECRET}`);
      expect(r.url).not.toContain(GATE_SECRET);
    }
  });

  it('creates a portal-managed user with slot attribute and groups', async () => {
    const pk = await anna({ name: 'Anna A' });
    const u = ak.users.get(pk)!;
    expect(u).toMatchObject({ username: 'anna', name: 'Anna A', email: 'anna@example.com', is_active: true, path: 'lokyy' });
    expect(u.attributes).toEqual({ lokyy_managed: true, lokyy_slot: 'v01' });
    expect(ak.groupNamesOf(pk)).toEqual(['vault-firma-read', 'vault-v01']);
  });

  it('is idempotent and updates name, email and groups of its own user', async () => {
    const pk = await anna({ email: 'a@example.com' });
    const again = await anna({ name: 'Anna B', email: 'b@example.com', groups: ['vault-v01', 'vault-firma-write'] });
    expect(again).toBe(pk);
    expect(ak.users.size).toBe(1);
    expect(ak.users.get(pk)).toMatchObject({ name: 'Anna B', email: 'b@example.com' });
    expect(ak.groupNamesOf(pk)).toEqual(['vault-firma-write', 'vault-v01']);
  });

  it('refuses to take over a user it did not create (a hand-made account or akadmin)', async () => {
    ak.addUser({ username: 'boss', attributes: {} });
    await expect(client.ensureUser({ username: 'boss', name: 'B', email: 'b@example.com', slot: 'v01', groups: [] }))
      .rejects.toMatchObject({ code: 'username_taken' });
    const root = ak.addUser({ username: 'akadmin', groups: [ak.groupPk('authentik Admins')] });
    await expect(client.setActive(root.pk, false)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(client.deleteUser(root.pk)).rejects.toMatchObject({ code: 'forbidden' });
    expect(ak.users.get(root.pk)!.is_active).toBe(true);
  });

  it('refuses a portal user that belongs to another slot', async () => {
    ak.addUser({ username: 'anna', path: 'lokyy', attributes: { lokyy_managed: true, lokyy_slot: 'v02' } });
    await expect(anna()).rejects.toMatchObject({ code: 'username_taken' });
  });

  it('keeps groups the portal does not manage when changing vault groups', async () => {
    const pk = await anna();
    ak.addToGroup(pk, 'some-team');
    await client.setGroups(pk, ['vault-v01', 'vault-firma-write', 'lokyy-users']);
    expect(ak.groupNamesOf(pk)).toEqual(['lokyy-users', 'some-team', 'vault-firma-write', 'vault-v01']);
    await client.setGroups(pk, []);
    expect(ak.groupNamesOf(pk)).toEqual(['some-team']);
  });

  it('cannot touch a user who was made a portal admin by hand', async () => {
    const pk = await anna();
    ak.addToGroup(pk, 'lokyy-admins');
    await expect(client.setGroups(pk, ['vault-v01'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(client.inviteLink(pk, 'days=7')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('fails loudly when a group of the contract is missing in Authentik', async () => {
    await expect(anna({ slot: 'v09', groups: ['vault-v09'] })).rejects.toMatchObject({ code: 'group_missing' });
  });

  it('creates an invitation (recovery) link with the requested validity', async () => {
    const pk = await anna();
    const link = await client.inviteLink(pk, 'days=7');
    expect(link).toMatch(/^https:\/\/auth\.example\.com\/if\/flow\/lokyy-set-password\/\?flow_token=/);
    expect(ak.recoveryRequests).toEqual([{ pk, token_duration: 'days=7' }]);
    expect(gate.logs.join('\n')).not.toContain('flow_token');
  });

  it('rewrites the link to the public Authentik URL (Authentik builds it from the internal host)', async () => {
    const pub = new AuthentikGateClient({ gateUrl: GATE_URL, publicUrl: 'https://auth.firma.de/', secret: GATE_SECRET, fetch: gate.fetch });
    const pk = await anna();
    expect(await pub.inviteLink(pk, 'days=7')).toBe(`https://auth.firma.de/if/flow/lokyy-set-password/?flow_token=tok${pk}`);
  });

  it('reports a missing recovery flow as its own error code', async () => {
    ak.recoveryFlowSet = false;
    const pk = await anna();
    await expect(client.inviteLink(pk, 'days=7')).rejects.toMatchObject({ code: 'no_recovery_flow' });
  });

  it('deactivates a user and ends their sessions', async () => {
    const pk = await anna();
    ak.sessions.push({ uuid: 's1', username: 'anna' }, { uuid: 's2', username: 'ben' });
    await client.setActive(pk, false);
    await client.endSessions(pk);
    expect(ak.users.get(pk)!.is_active).toBe(false);
    expect(ak.sessions.map((s) => s.uuid)).toEqual(['s2']);
  });

  it('deletes a user; deleting or ending sessions of a missing user is not an error', async () => {
    const pk = await anna();
    await client.deleteUser(pk);
    expect(ak.users.size).toBe(0);
    await expect(client.deleteUser(pk)).resolves.toBeUndefined();
    await expect(client.endSessions(pk)).resolves.toBeUndefined();
  });

  it('turns gate errors into AuthentikError without upstream details', async () => {
    ak.failNext = { status: 500, body: 'internal tok-secret detail' };
    const err = await anna().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthentikError);
    expect(String((err as Error).message)).not.toContain('tok-secret');
    expect((err as AuthentikError).status).toBe(502);
  });

  it('reports an unreachable gate', async () => {
    gate.down = true;
    await expect(anna()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('a wrong gate secret is an error, not a silent success', async () => {
    const wrong = new AuthentikGateClient({ gateUrl: GATE_URL, secret: 'x'.repeat(40), fetch: gate.fetch });
    await expect(wrong.ensureUser({ username: 'anna', name: 'A', email: 'a@example.com', slot: 'v01', groups: [] }))
      .rejects.toMatchObject({ code: 'http', status: 401 });
    expect(ak.requests).toHaveLength(0);
  });
});
