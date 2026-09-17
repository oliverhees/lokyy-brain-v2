import { describe, expect, it } from 'vitest';
import { applyModelPolicy } from '../transformers-offline';

describe('applyModelPolicy (LBV2-24)', () => {
  it('disables remote model downloads when MINDBASE_MODELS_OFFLINE=1', () => {
    const env = { allowRemoteModels: true, cacheDir: '/pkg/.cache' };
    applyModelPolicy(env, { MINDBASE_MODELS_OFFLINE: '1' });
    expect(env.allowRemoteModels).toBe(false);
    expect(env.cacheDir).toBe('/pkg/.cache');
  });

  it('uses MINDBASE_MODELS_DIR as the transformers cache when it is absolute', () => {
    const env = { allowRemoteModels: true, cacheDir: '/pkg/.cache' };
    applyModelPolicy(env, { MINDBASE_MODELS_OFFLINE: 'true', MINDBASE_MODELS_DIR: '/models' });
    expect(env).toEqual({ allowRemoteModels: false, cacheDir: '/models' });
  });

  it('ignores a relative MINDBASE_MODELS_DIR', () => {
    const env = { allowRemoteModels: true, cacheDir: '/pkg/.cache' };
    applyModelPolicy(env, { MINDBASE_MODELS_OFFLINE: '1', MINDBASE_MODELS_DIR: 'models' });
    expect(env.cacheDir).toBe('/pkg/.cache');
  });

  it('keeps downloads enabled without the flag (local development)', () => {
    const env = { allowRemoteModels: true, cacheDir: '/pkg/.cache' };
    applyModelPolicy(env, {});
    expect(env.allowRemoteModels).toBe(true);
  });
});
