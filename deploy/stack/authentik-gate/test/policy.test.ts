import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedGroup, targetRefusal, validateCreate, validateUpdate } from '../src/policy.ts';

const NUL = String.fromCharCode(0);
const user = (o: Record<string, unknown> = {}) => ({
  pk: 7, username: 'anna', type: 'internal', is_superuser: false, attributes: { lokyy_managed: true, lokyy_slot: 'v01' },
  groups_obj: [{ name: 'vault-v01', is_superuser: false }], ...o,
});

test('only vault slots, company vault read/write and lokyy-users are assignable', () => {
  for (const g of ['vault-v01', 'vault-v123', 'vault-firma-read', 'vault-firma-write', 'lokyy-users']) assert.equal(isAllowedGroup(g), true, g);
  for (const g of ['lokyy-admins', 'authentik Admins', 'vault-v1', 'vault-firma-admin', 'vault-v01-admin', 'vault-anna', '', 'Lokyy-users']) assert.equal(isAllowedGroup(g), false, g);
});

test('a managed employee is an acceptable target', () => {
  assert.equal(targetRefusal(user()), null);
});

test('refuses unmanaged users, superusers, admins, service accounts and akadmin', () => {
  assert.equal(targetRefusal(user({ attributes: {} })), 'not_managed');
  assert.equal(targetRefusal(user({ attributes: { lokyy_managed: 'true' } })), 'not_managed');
  assert.equal(targetRefusal(user({ is_superuser: true })), 'privileged');
  assert.equal(targetRefusal(user({ groups_obj: [{ name: 'authentik Admins', is_superuser: true }] })), 'privileged');
  assert.equal(targetRefusal(user({ groups_obj: [{ name: 'lokyy-admins', is_superuser: false }] })), 'privileged');
  assert.equal(targetRefusal(user({ groups_obj: [{ name: 'something', is_superuser: true }] })), 'privileged');
  assert.equal(targetRefusal(user({ type: 'service_account' })), 'privileged');
  assert.equal(targetRefusal(user({ username: 'akadmin' })), 'privileged');
  assert.equal(targetRefusal(user({ groups_obj: undefined })), 'unknown_groups');
});

test('create input: username rule, e-mail, name, slot, groups from the allowlist, nothing else', () => {
  const ok = { username: 'anna', name: 'Anna', email: 'anna@example.com', slot: 'v01', groups: ['vault-v01', 'lokyy-users'] };
  assert.deepEqual(validateCreate(ok), { ok: true, value: ok });
  for (const bad of [
    { ...ok, username: 'Anna' }, { ...ok, username: 'akadmin' }, { ...ok, email: 'x' }, { ...ok, name: '' },
    { ...ok, name: `a${NUL}b` }, { ...ok, slot: 'x' }, { ...ok, groups: ['lokyy-admins'] }, { ...ok, groups: 'vault-v01' },
    { ...ok, extra: 1 }, null, [],
  ]) assert.equal(validateCreate(bad).ok, false, JSON.stringify(bad));
});

test('update input: only name, email, isActive, groups; groups from the allowlist', () => {
  assert.deepEqual(validateUpdate({ name: 'A', isActive: false }), { ok: true, value: { name: 'A', isActive: false } });
  assert.equal(validateUpdate({ groups: ['authentik Admins'] }).ok, false);
  assert.equal(validateUpdate({ is_superuser: true }).ok, false);
  assert.equal(validateUpdate({ password: 'x' }).ok, false);
  assert.equal(validateUpdate({ attributes: {} }).ok, false);
  assert.equal(validateUpdate({ isActive: 'no' }).ok, false);
  assert.equal(validateUpdate({}).ok, false);
});
