import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGate } from '../src/gate.ts';
import { FakeAuthentik } from './fake-authentik.ts';

const SECRET = 's'.repeat(40);
let ak: FakeAuthentik;
let gate: http.Server;
let base = '';
const logs: string[] = [];

before(async () => {
  ak = new FakeAuthentik('ak-token');
  await ak.start();
  gate = createGate({ authentikUrl: ak.url, authentikToken: 'ak-token', secret: SECRET, log: (l) => logs.push(l), ratePerMinute: 1000 });
  await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
});
after(() => { gate.closeAllConnections(); gate.close(); ak.stop(); });
beforeEach(() => { logs.length = 0; });

const call = async (method: string, path: string, body?: unknown, secret = SECRET) => {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const create = (username: string, groups = ['vault-v01', 'vault-firma-read', 'lokyy-users']) =>
  call('POST', '/v1/users', { username, name: username, email: `${username}@example.com`, slot: 'v01', groups });
const akadmin = () => [...ak.users.values()].find((u) => u.username === 'akadmin')!;

test('rejects missing or wrong bearer secret without touching Authentik', async () => {
  const before = ak.requests.length;
  assert.equal((await call('GET', '/v1/users', undefined, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/v1/users`)).status, 401);
  assert.equal(ak.requests.length, before);
});

test('creates a managed user with allowlisted groups; the gate sets lokyy_managed and the path itself', async () => {
  const r = await create('anna');
  assert.equal(r.status, 201);
  const u = ak.users.get(r.body.user.pk)!;
  assert.deepEqual(u.attributes, { lokyy_managed: true, lokyy_slot: 'v01' });
  assert.equal(u.path, 'lokyy');
  assert.deepEqual(ak.groupNames(u.pk), ['lokyy-users', 'vault-firma-read', 'vault-v01']);
  assert.deepEqual(r.body.user, { pk: u.pk, username: 'anna', name: 'anna', email: 'anna@example.com', isActive: true, slot: 'v01', groups: ['lokyy-users', 'vault-firma-read', 'vault-v01'] });
  assert.ok(logs.some((l) => l.includes('"action":"create"') && l.includes('"target":"anna"')));
});

test('refuses admin or superuser groups and unknown fields on create', async () => {
  assert.equal((await create('ben', ['lokyy-admins'])).status, 400);
  assert.equal((await create('ben', ['authentik Admins'])).status, 400);
  assert.equal((await call('POST', '/v1/users', { username: 'ben', name: 'b', email: 'b@example.com', slot: 'v02', groups: [], attributes: { x: 1 } })).status, 400);
  assert.equal((await call('POST', '/v1/users', { username: 'ben', name: 'b', email: 'b@example.com', slot: 'v02', groups: [], is_superuser: true })).status, 400);
});

test('lookup tells managed, foreign and absent apart', async () => {
  await create('carl');
  assert.equal((await call('POST', '/v1/users/lookup', { username: 'carl' })).body.status, 'managed');
  assert.equal((await call('POST', '/v1/users/lookup', { username: 'akadmin' })).body.status, 'foreign');
  assert.deepEqual((await call('POST', '/v1/users/lookup', { username: 'akadmin' })).body, { status: 'foreign' }); // no data of foreign users
  assert.equal((await call('POST', '/v1/users/lookup', { username: 'nobody' })).body.status, 'absent');
});

test('update: name, email, active and groups of a managed user; non-allowlisted groups are neither added nor removed', async () => {
  const pk = (await create('dora')).body.user.pk;
  ak.users.get(pk)!.groups.push('g-custom');
  ak.groups.set('g-custom', { name: 'some-other-group', is_superuser: false });
  const r = await call('PATCH', `/v1/users/${pk}`, { name: 'Dora D', isActive: false, groups: ['vault-v01', 'vault-firma-write', 'lokyy-users'] });
  assert.equal(r.status, 200);
  const u = ak.users.get(pk)!;
  assert.equal(u.name, 'Dora D');
  assert.equal(u.is_active, false);
  assert.deepEqual(ak.groupNames(pk), ['lokyy-users', 'some-other-group', 'vault-firma-write', 'vault-v01']);
});

test('every write on akadmin is refused (403) and nothing reaches Authentik', async () => {
  const pk = akadmin().pk;
  const before = ak.requests.filter((r) => r.method !== 'GET').length;
  assert.equal((await call('PATCH', `/v1/users/${pk}`, { isActive: false })).status, 403);
  assert.equal((await call('PATCH', `/v1/users/${pk}`, { groups: ['lokyy-users'] })).status, 403);
  assert.equal((await call('POST', `/v1/users/${pk}/recovery`, { tokenDuration: 'days=1' })).status, 403);
  assert.equal((await call('DELETE', `/v1/users/${pk}`)).status, 403);
  assert.equal((await call('DELETE', `/v1/users/${pk}/sessions`)).status, 403);
  assert.equal(ak.requests.filter((r) => r.method !== 'GET').length, before);
  assert.equal(akadmin().is_active, true);
});

test('members of lokyy-admins are refused even when marked managed', async () => {
  const admin = ak.addUser({ username: 'chef', attributes: { lokyy_managed: true, lokyy_slot: 'v02' }, groups: [ak.groupPk('lokyy-admins')] });
  assert.equal((await call('PATCH', `/v1/users/${admin.pk}`, { isActive: false })).status, 403);
  assert.equal((await call('POST', `/v1/users/${admin.pk}/recovery`, { tokenDuration: 'days=1' })).status, 403);
  assert.equal((await call('DELETE', `/v1/users/${admin.pk}`)).status, 403);
});

test('unmanaged users are refused', async () => {
  const other = ak.addUser({ username: 'hand-made' });
  assert.equal((await call('DELETE', `/v1/users/${other.pk}`)).status, 403);
  assert.ok(ak.users.has(other.pk));
});

test('no password endpoint, no passthrough', async () => {
  const pk = (await create('erik')).body.user.pk;
  assert.equal((await call('POST', `/v1/users/${pk}/set_password`, { password: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/v3/core/users/', {})).status, 404);
  assert.equal((await call('GET', `/v1/users/${pk}/../../..`)).status, 404);
  assert.ok(!ak.requests.some((r) => r.path.includes('set_password')));
});

test('recovery link for a managed user; validity at most 14 days', async () => {
  const pk = (await create('fritz')).body.user.pk;
  const r = await call('POST', `/v1/users/${pk}/recovery`, { tokenDuration: 'days=7' });
  assert.equal(r.status, 200);
  assert.match(r.body.link, /flow_token=/);
  assert.equal((await call('POST', `/v1/users/${pk}/recovery`, { tokenDuration: 'days=15' })).status, 400);
  assert.equal((await call('POST', `/v1/users/${pk}/recovery`, { tokenDuration: 'weeks=1' })).status, 400);
  assert.ok(!logs.some((l) => l.includes('flow_token')));
});

test('ends sessions of and deletes a managed user', async () => {
  const pk = (await create('gerd')).body.user.pk;
  ak.sessions.push({ uuid: 's1', username: 'gerd' }, { uuid: 's2', username: 'akadmin' });
  assert.equal((await call('DELETE', `/v1/users/${pk}/sessions`)).status, 204);
  assert.deepEqual(ak.sessions.map((s) => s.uuid), ['s2']);
  assert.equal((await call('DELETE', `/v1/users/${pk}`)).status, 204);
  assert.ok(!ak.users.has(pk));
  assert.equal((await call('DELETE', `/v1/users/${pk}`)).status, 404);
});

test('ending sessions also purges the outpost (forward-auth) sessions via the fixed lokyy-end-proxy-sessions policy', async () => {
  const pk = (await create('pia')).body.user.pk;
  ak.proxySessions.push({ username: 'pia' }, { username: 'pia' }, { username: 'akadmin' });
  const tests = () => ak.requests.filter((r) => r.path === '/api/v3/policies/all/pol-purge/test/').length;
  const before = tests();
  assert.equal((await call('DELETE', `/v1/users/${pk}/sessions`)).status, 204);
  assert.deepEqual(ak.proxySessions.map((s) => s.username), ['akadmin']);
  assert.equal(tests() - before, 1, 'the exact-name policy, not the similarly named one');
  assert.ok(logs.some((l) => l.includes('"action":"end_sessions"') && l.includes('"outpost":true')), logs.join('\n'));
});

test('ending sessions fails loudly (502) when the outpost purge policy is missing or does not pass', async () => {
  const pk = (await create('quirin')).body.user.pk;
  try {
    for (const mode of ['missing', 'fails'] as const) {
      ak.purgePolicy = mode;
      ak.proxySessions.push({ username: 'quirin' });
      assert.equal((await call('DELETE', `/v1/users/${pk}/sessions`)).status, 502, mode);
    }
  } finally { ak.purgePolicy = 'ok'; }
  // refused targets never reach the policy
  const before = ak.requests.filter((r) => r.path.includes('/policies/')).length;
  assert.equal((await call('DELETE', `/v1/users/${akadmin().pk}/sessions`)).status, 403);
  assert.equal(ak.requests.filter((r) => r.path.includes('/policies/')).length, before);
});

test('lists managed users only', async () => {
  await create('hans');
  const names = (await call('GET', '/v1/users')).body.users.map((u: { username: string }) => u.username);
  assert.ok(names.includes('hans'));
  assert.ok(!names.includes('akadmin'));
  assert.ok(!names.includes('hand-made'));
});

test('generic errors: body limit, bad JSON, rate limit', async () => {
  const big = await fetch(`${base}/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: 'x'.repeat(20_000) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${base}/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  const small = createGate({ authentikUrl: ak.url, authentikToken: 'ak-token', secret: SECRET, log: () => {}, ratePerMinute: 2 });
  await new Promise<void>((r) => small.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${(small.address() as AddressInfo).port}/v1/users`;
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(u, { headers: { authorization: `Bearer ${SECRET}` } })).status);
  small.closeAllConnections(); small.close();
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('Authentik errors are reported generically, never with upstream bodies', async () => {
  ak.recoveryFlowSet = false;
  const pk = (await create('ines')).body.user.pk;
  const r = await call('POST', `/v1/users/${pk}/recovery`, { tokenDuration: 'days=1' });
  ak.recoveryFlowSet = true;
  assert.deepEqual(r, { status: 424, body: { error: 'no_recovery_flow' } });
});
