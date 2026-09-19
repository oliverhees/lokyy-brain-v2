// LBV2-27 — tests for the YAML-parsing blueprint checker (tests/blueprint-check.ts).
// Run: node --test deploy/stack/tests/blueprint-check.test.ts   (needs Docker: the Authentik image parses the YAML)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './blueprint-check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const f = (name: string) => join(here, 'fixtures', name);
const repo = join(here, '../../..');

const results = checkFiles([
  f('blueprint-akadmin-bad.yaml'), f('blueprint-akadmin-good.yaml'), f('blueprint-akadmin-bad-tricky.yaml'),
  f('blueprint-akadmin-good-tricky.yaml'), f('blueprint-proxy-bad.yaml'), f('blueprint-proxy-good.yaml'),
  join(repo, 'deploy/stack/authentik/blueprints/lokyy-vaults.yaml'),
  join(repo, 'deploy/coolify/authentik/blueprints/lokyy-s.yaml'), join(repo, 'deploy/coolify/authentik/blueprints/lokyy-m.yaml'),
]);
const problems = (name: string) => results.get(name) ?? assert.fail(`no result for ${name}`);

test('akadmin: plain group lists are rejected (block and flow style)', () => {
  assert.equal(problems(f('blueprint-akadmin-bad.yaml')).filter((p) => p.includes('authentik Admins')).length, 3);
});
test('akadmin: quoted name, last-line username, 4-space indent, string-only mention, alias: all rejected', () => {
  assert.equal(problems(f('blueprint-akadmin-bad-tricky.yaml')).filter((p) => p.includes('authentik Admins')).length, 4);
});
test('akadmin entries depend on the system bootstrap blueprint', () => {
  assert.ok(problems(f('blueprint-akadmin-good.yaml')).some((p) => p.includes('authentik Bootstrap')));
});
test('akadmin: !Find authentik Admins accepted, also via anchors and merge keys', () => {
  assert.deepEqual(problems(f('blueprint-akadmin-good-tricky.yaml')), []);
});
test('proxy providers need explicit property mappings and the scope blueprints', () => {
  const p = problems(f('blueprint-proxy-bad.yaml'));
  assert.ok(p.some((x) => x.includes('property_mappings')));
  assert.ok(p.some((x) => x.includes('System - Proxy Provider - Scopes')));
  assert.ok(p.some((x) => x.includes('System - OAuth2 Provider - Scopes')));
  assert.deepEqual(problems(f('blueprint-proxy-good.yaml')), []);
});
test('shipped blueprints pass', () => {
  for (const b of ['deploy/stack/authentik/blueprints/lokyy-vaults.yaml', 'deploy/coolify/authentik/blueprints/lokyy-s.yaml', 'deploy/coolify/authentik/blueprints/lokyy-m.yaml']) {
    assert.deepEqual(problems(join(repo, b)), [], b);
  }
});
