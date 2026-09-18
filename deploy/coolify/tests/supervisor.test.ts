// LBV2-27 — unit tests for the MetaMCP provisioning watcher (metamcp/supervisor.mjs).
// Run: node --test deploy/coolify/tests/supervisor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module (the MetaMCP image runs Node 20)
import { RETRY_MAX, RETRY_MS, RestartGuard, Tracker, clientsFile, contentHash, parseUsers, rotationList } from '../metamcp/supervisor.mjs';

const spec = (users: object[], generation = 1) => ({ companyVault: 'firma', generation, users });
const u = (username: string, extra: object = {}) => ({ username, role: 'writer', vault: `v0${username.length}`, allowVaultNameMismatch: true, ...extra });

test('parseUsers: only well-formed provisioning input is acted on', () => {
  assert.equal(parseUsers('{'), null);
  assert.equal(parseUsers('{"users":[]}'), null, 'companyVault missing');
  assert.equal(parseUsers('{"companyVault":"firma","users":{}}'), null);
  assert.deepEqual(parseUsers(JSON.stringify(spec([]))), spec([]));
});

test('rotationList: rotate iff keyRotation differs from the value recorded for a delivered key', () => {
  const previous = { users: [
    { username: 'anna', status: 'ok', apiKey: 'k', keyRotation: 'a1' },
    { username: 'ben', status: 'ok', apiKey: 'k' },
    { username: 'carl', status: 'failed', keyRotation: 'c1' },
  ] };
  const s = spec([u('anna', { keyRotation: 'a2' }), u('ben', { keyRotation: 'b1' }), u('carl', { keyRotation: 'c2' }), u('dora', { keyRotation: 'd1' })]);
  assert.deepEqual(rotationList(s, previous), ['anna', 'ben'], 'first key (dora) and not-yet-delivered (carl) need no extra rotation');
  assert.deepEqual(rotationList(spec([u('anna', { keyRotation: 'a1' })]), previous), []);
  assert.deepEqual(rotationList(s, null), []);
});

test('clientsFile: per-user status, keys only for ok users, never users the portal did not list', () => {
  const s = spec([u('anna', { keyRotation: 'a2' }), u('ben', { keyRotation: 'b2' }), u('carl')], 7);
  const result = { status: 'failed', restartMetamcp: true, removed: ['old'], users: [
    { username: 'anna', role: 'writer', vault: 'v04', status: 'ok', url: 'https://mcp.x/metamcp/anna/mcp', apiKey: 'sk_a' },
    { username: 'ben', role: 'writer', vault: 'v03', status: 'failed', error: 'boom' },
    { username: 'eve', role: 'writer', vault: 'v09', status: 'ok', url: 'u', apiKey: 'sk_e' },
  ] };
  const previous = { users: [{ username: 'ben', keyRotation: 'b1', status: 'ok', apiKey: 'old' }] };
  const f = clientsFile(s, result, previous, { now: new Date(0) });
  assert.equal(f.sourceGeneration, 7);
  assert.equal(f.status, 'failed');
  assert.equal(f.restartMetamcp, true);
  assert.deepEqual(f.removed, ['old']);
  assert.deepEqual(f.users.map((x: { username: string; status: string }) => [x.username, x.status]), [['anna', 'ok'], ['ben', 'failed'], ['carl', 'failed']]);
  assert.equal(f.users[0].apiKey, 'sk_a');
  assert.equal(f.users[0].keyRotation, 'a2', 'applied value recorded');
  assert.equal(f.users[1].apiKey, undefined, 'no key for a failed user');
  assert.equal(f.users[1].keyRotation, 'b1', 'rotation stays outstanding');
  assert.equal(f.users[2].error, 'not processed');
  assert.ok(!JSON.stringify(f).includes('sk_e'));
});

test('clientsFile: all ok -> ok; restart skipped is reported', () => {
  const f = clientsFile(spec([u('anna')]), { status: 'ok', users: [{ username: 'anna', status: 'ok', apiKey: 'k', url: 'u' }] }, null, { restartSkipped: true });
  assert.equal(f.status, 'ok');
  assert.equal(f.restartSkipped, true);
});

test('RestartGuard: at most 3 restarts per 10 minutes (no restart loop)', () => {
  const g = new RestartGuard(3, 600_000);
  assert.deepEqual([0, 1, 2, 3].map((i) => g.allow(1000 + i)), [true, true, true, false]);
  assert.equal(g.allow(1000 + 600_000), true, 'window slides');
});

test('Tracker: new content once; failed content retried with backoff, bounded', () => {
  const t = new Tracker();
  const h = contentHash('a');
  assert.equal(t.due(h, 0), true);
  t.record(h, true, 0);
  assert.equal(t.due(h, 10 * RETRY_MS), false, 'successful content is never reprocessed');
  assert.equal(t.due(contentHash('b'), 1), true);
  const h2 = contentHash('c');
  let now = 0;
  t.record(h2, false, now);
  assert.equal(t.due(h2, now + 1), false, 'backoff');
  let retries = 0;
  for (let i = 0; i < 20; i++) { now += RETRY_MS; if (t.due(h2, now)) { retries++; t.record(h2, false, now); } }
  assert.equal(retries, RETRY_MAX - 1);
});
