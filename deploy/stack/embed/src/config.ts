// Configuration helpers for the embed service. Everything here fails closed: a missing or malformed
// setting stops the service instead of starting it with weaker checks.
import { isAbsolute } from 'node:path';

const VAULT_RE = /^[a-z][a-z0-9-]{0,62}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Env var holding a vault's token hash: EMBED_TOKEN_SHA256_<VAULT>, upper case, `-` → `_`. */
export const tokenHashVar = (vault: string) => `EMBED_TOKEN_SHA256_${vault.toUpperCase().replaceAll('-', '_')}`;

/**
 * Reads the vault → sha256(token) mapping. `vaultsCsv` is EMBED_VAULTS (e.g. "anna,ben,firma"); each
 * vault needs EMBED_TOKEN_SHA256_<VAULT> as 64 hex characters. The service never sees plain tokens.
 */
export function parseTokenConfig(vaultsCsv: string, env: Record<string, string | undefined>): Map<string, string> {
  const vaults = vaultsCsv.split(',').map((v) => v.trim()).filter(Boolean);
  if (vaults.length === 0) throw new Error('EMBED_VAULTS is empty');
  const tokens = new Map<string, string>();
  const seen = new Set<string>();
  for (const vault of vaults) {
    if (!VAULT_RE.test(vault)) throw new Error(`invalid vault name in EMBED_VAULTS: ${vault}`);
    if (tokens.has(vault)) throw new Error(`duplicate vault in EMBED_VAULTS: ${vault}`);
    const name = tokenHashVar(vault);
    const hash = (env[name] ?? '').trim().toLowerCase();
    if (!SHA256_RE.test(hash)) throw new Error(`${name} must be the sha256 hex digest of the vault's token`);
    if (seen.has(hash)) throw new Error(`two vaults use the same token (${name})`);
    seen.add(hash);
    tokens.set(vault, hash);
  }
  return tokens;
}

/** The part of @xenova/transformers' `env` the service sets. */
export interface TransformersEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  cacheDir: string | null;
  useFSCache: boolean;
  localModelPath: string;
}

/**
 * Offline model loading: never download, read the model only from `modelsDir` (the verified,
 * read-only /models volume). transformers.js looks a file up in the cache first (key
 * `<model>/<file>`), then under localModelPath, so both point at the same directory.
 */
export function configureTransformersEnv(env: TransformersEnv, modelsDir: string): void {
  if (!isAbsolute(modelsDir)) throw new Error('EMBED_MODELS_DIR must be an absolute path');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = true;
  env.cacheDir = modelsDir;
  env.localModelPath = modelsDir.endsWith('/') ? modelsDir : `${modelsDir}/`;
}
