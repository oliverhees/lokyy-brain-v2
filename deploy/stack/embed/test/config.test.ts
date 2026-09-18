import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenConfig, configureTransformersEnv } from '../src/config.ts';

const H1 = '1'.repeat(64);
const H2 = 'ab'.repeat(32);

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
