import { isAbsolute } from 'node:path';

/** The part of @xenova/transformers' `env` this policy touches. */
export interface TransformersModelEnv {
  allowRemoteModels: boolean;
  cacheDir: string | null;
}

/**
 * Hosted vaults (LBV2-24): with MINDBASE_MODELS_OFFLINE=1|true|yes, transformers.js may only load
 * models from its local cache (the verified, read-only /models volume) and never downloads a model
 * file. MINDBASE_MODELS_DIR (absolute) overrides the cache directory. Without the flag nothing
 * changes, so local development still downloads models on first use.
 * The container additionally loads deploy/stack/models/offline.mjs as a second layer.
 */
export function applyModelPolicy(env: TransformersModelEnv, processEnv: Record<string, string | undefined> = process.env): void {
  const offline = /^(1|true|yes)$/i.test(processEnv['MINDBASE_MODELS_OFFLINE'] ?? '');
  if (!offline) return;
  env.allowRemoteModels = false;
  const dir = processEnv['MINDBASE_MODELS_DIR'];
  if (dir && isAbsolute(dir)) env.cacheDir = dir;
}
