import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenConfig, parseSourceConfig, plainTokenVars, inNetworks, configureTransformersEnv } from '../src/config.ts';

const H1 = '1'.repeat(64);
const H2 = 'ab'.repeat(32);
// Strong-enough plain tokens (≥ 16 distinct characters)
const P1 = '0123456789abcdefghij'.repeat(2);
const P2 = 'klmnopqrstuvwxyzABCD'.repeat(2);

test('token hashes are read per vault from EMBED_TOKEN_SHA256_<VAULT>', () => {
  const m = parseTokenConfig('anna, ben,my-firma', {
    EMBED_TOKEN_SHA256_ANNA: H1,
    EMBED_TOKEN_SHA256_BEN: H2.toUpperCase(),
    EMBED_TOKEN_SHA256_MY_FIRMA: '2'.repeat(64),
  });
  assert.deepEqual([...m.entries()], [['anna', H1], ['ben', H2], ['my-firma', '2'.repeat(64)]]);
});

test('fails closed on missing vaults, missing or malformed hashes and bad vault names', () => {
  assert.throws(() => parseTokenConfig('', {}), /EMBED_VAULTS/);
  assert.throws(() => parseTokenConfig('anna', {}), /EMBED_TOKEN_SHA256_ANNA/);
  assert.throws(() => parseTokenConfig('anna', { EMBED_TOKEN_SHA256_ANNA: 'plain-token' }), /EMBED_TOKEN_SHA256_ANNA/);
  assert.throws(() => parseTokenConfig('Anna', { EMBED_TOKEN_SHA256_ANNA: H1 }), /vault name/);
  assert.throws(() => parseTokenConfig('anna,anna', { EMBED_TOKEN_SHA256_ANNA: H1 }), /duplicate/);
});

test('two vaults with the same token hash are refused (a token must identify one vault)', () => {
  assert.throws(() => parseTokenConfig('anna,ben', { EMBED_TOKEN_SHA256_ANNA: H1, EMBED_TOKEN_SHA256_BEN: H1 }), /same token/);
});

test('transformers env: remote models off, cache and local model path both point at the models dir', () => {
  const env = { allowRemoteModels: true, allowLocalModels: false, cacheDir: '/somewhere', useFSCache: false, localModelPath: '/x/' };
  configureTransformersEnv(env, '/models');
  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.cacheDir, '/models');
  assert.equal(env.useFSCache, true);
  // transformers.js refuses to load anything with both local and remote models disabled
  assert.equal(env.allowLocalModels, true);
  assert.equal(env.localModelPath, '/models/');
});

test('transformers env: the models dir must be absolute', () => {
  assert.throws(() => configureTransformersEnv({ allowRemoteModels: true, allowLocalModels: true, cacheDir: null, useFSCache: true, localModelPath: '' }, 'models'), /absolute/);
});

test('source networks per vault from EMBED_SOURCE_<VAULT> (optional, IPv4 CIDR list)', () => {
  const m = parseSourceConfig(['anna', 'ben', 'firma'], { EMBED_SOURCE_ANNA: '10.232.12.0/28', EMBED_SOURCE_BEN: '10.1.0.0/16, 192.168.1.7/32' });
  assert.deepEqual(m.get('anna'), [{ base: 0x0ae80c00, bits: 28 }]);
  assert.deepEqual(m.get('ben'), [{ base: 0x0a010000, bits: 16 }, { base: 0xc0a80107, bits: 32 }]);
  assert.equal(m.has('firma'), false);
  for (const bad of ['10.0.0.0', '10.0.0.1/28', '300.0.0.0/8', '10.0.0.0/33', 'fe80::/10', ' ']) {
    assert.throws(() => parseSourceConfig(['anna'], { EMBED_SOURCE_ANNA: bad }), /EMBED_SOURCE_ANNA/, bad);
  }
});

test('address matching handles IPv4-mapped IPv6 and rejects anything else', () => {
  const nets = [{ base: 0x0ae80c00, bits: 28 }];
  assert.equal(inNetworks('10.232.12.3', nets), true);
  assert.equal(inNetworks('::ffff:10.232.12.14', nets), true);
  assert.equal(inNetworks('10.232.12.16', nets), false);
  assert.equal(inNetworks('::1', nets), false);
  assert.equal(inNetworks(undefined, nets), false);
});

test('plain tokens (EMBED_TOKEN_<VAULT>, e.g. Coolify magic env) are hashed at startup', async () => {
  const { createHash } = await import('node:crypto');
  const plain = P1;
  const m = parseTokenConfig('v01,v30,firma', {
    EMBED_TOKEN_V01: plain,
    EMBED_TOKEN_SHA256_V30: H2,
    EMBED_TOKEN_FIRMA: P2,
  });
  assert.equal(m.get('v01'), createHash('sha256').update(plain).digest('hex'));
  assert.equal(m.get('v30'), H2);
  assert.equal(m.get('firma'), createHash('sha256').update(P2).digest('hex'));
});

test('plain and hashed token for the same vault is a startup error; weak plain tokens are refused', () => {
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: P1, EMBED_TOKEN_SHA256_V01: H1 }), /both EMBED_TOKEN_V01 and EMBED_TOKEN_SHA256_V01/);
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: 'short' }), /EMBED_TOKEN_V01 must be/);
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: `${P1} x` }), /EMBED_TOKEN_V01 must be/);
  assert.throws(() => parseTokenConfig('v01,v02', { EMBED_TOKEN_V01: P1, EMBED_TOKEN_V02: P1 }), /same token/);
});

test('error messages never contain a plain token', () => {
  const secret = P2;
  for (const env of [{ EMBED_TOKEN_V01: secret, EMBED_TOKEN_SHA256_V01: H1 }, { EMBED_TOKEN_V01: secret, EMBED_TOKEN_V02: secret }]) {
    try { parseTokenConfig('v01,v02', env); assert.fail('expected an error'); } catch (e) {
      assert.ok(!(e as Error).message.includes(secret));
    }
  }
});

test('plainTokenVars lists the plain token variables to scrub from process.env', () => {
  assert.deepEqual(plainTokenVars(['v01', 'my-firma']), ['EMBED_TOKEN_V01', 'EMBED_TOKEN_MY_FIRMA']);
});

test('slot names v01..v30 and firma are valid vault names', () => {
  const env: Record<string, string> = { EMBED_TOKEN_SHA256_FIRMA: 'f'.repeat(64) };
  const names = Array.from({ length: 30 }, (_, i) => `v${String(i + 1).padStart(2, '0')}`);
  names.forEach((n, i) => { env[`EMBED_TOKEN_SHA256_${n.toUpperCase()}`] = i.toString(16).padStart(64, '0'); });
  assert.equal(parseTokenConfig([...names, 'firma'].join(','), env).size, 31);
});

test('vault names starting with "sha256-" are refused: EMBED_TOKEN_SHA256_X would be both vault "sha256-x"\'s plain token and vault "x"\'s hash', () => {
  assert.throws(() => parseTokenConfig('sha256-x', { EMBED_TOKEN_SHA256_X: 'k'.repeat(40) }), /vault name/);
  assert.throws(() => parseTokenConfig('x,sha256-x', { EMBED_TOKEN_SHA256_X: H1 }), /vault name/);
});

test('any env-name collision between vaults is a startup error', () => {
  // "a-b" and "a_b" are not valid names, but "ab-c" vs "ab" + suffix could collide in future naming: check generically
  assert.throws(() => parseTokenConfig('v01,v01-', { EMBED_TOKEN_SHA256_V01: H1 }), /vault name|collid/);
});

test('trivial plain tokens (fewer than 16 distinct characters) are refused', () => {
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: 'a'.repeat(32) }), /EMBED_TOKEN_V01 must/);
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: 'abababababababababababababababab' }), /EMBED_TOKEN_V01 must/);
  assert.throws(() => parseTokenConfig('v01', { EMBED_TOKEN_V01: '0123456789abcde'.repeat(3) }), /EMBED_TOKEN_V01 must/);
  const hex = '0123456789abcdef'.repeat(2) + 'f00dbabe';
  assert.equal(parseTokenConfig('v01', { EMBED_TOKEN_V01: hex }).size, 1);
});
