// Configuration helpers for the embed service. Everything here fails closed: a missing or malformed
// setting stops the service instead of starting it with weaker checks.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// Lowercase words joined by single dashes, at most 63 characters. Names starting with "sha256-" are
// refused: EMBED_TOKEN_SHA256_X would be both vault "sha256-x"'s plain token and vault "x"'s hash.
const VAULT_RE = /^(?!sha256-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Plain tokens must look randomly generated (LBV2-36; the previous "≥ 16 distinct characters" rule
 * refused ~25 % of `openssl rand -hex 32` tokens, which only have 16 possible characters):
 * - 32–512 printable ASCII characters without spaces;
 * - hex-only tokens: at least 64 characters and 8 distinct ones (`openssl rand -hex 32`);
 *   any other alphabet: at least 12 distinct characters (e.g. 32 random alphanumerics);
 * - no single character makes up more than a third of the token, and the token is not a
 *   repetition of a shorter string.
 */
export function isStrongPlainToken(t: string): boolean {
  if (!/^[\x21-\x7e]{32,512}$/.test(t)) return false;
  const counts = new Map<string, number>();
  for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
  const hex = /^[0-9a-fA-F]+$/.test(t);
  if (hex ? t.length < 64 || counts.size < 8 : counts.size < 12) return false;
  if (Math.max(...counts.values()) > t.length / 3) return false;
  for (let p = 1; p <= t.length / 2; p++) {
    if (t.length % p === 0 && t.slice(0, p).repeat(t.length / p) === t) return false;
  }
  return true;
}
const SHA256_RE = /^[0-9a-f]{64}$/;

const envSuffix = (vault: string) => vault.toUpperCase().replaceAll('-', '_');
/** Env var holding a vault's token hash: EMBED_TOKEN_SHA256_<VAULT>, upper case, `-` → `_`. */
export const tokenHashVar = (vault: string) => `EMBED_TOKEN_SHA256_${envSuffix(vault)}`;
/** Env var holding a vault's plain token: EMBED_TOKEN_<VAULT> (e.g. Coolify magic variables). */
export const tokenPlainVar = (vault: string) => `EMBED_TOKEN_${envSuffix(vault)}`;
/** Plain token variables of these vaults; main.ts deletes them from process.env after parsing. */
export const plainTokenVars = (vaults: readonly string[]) => vaults.map(tokenPlainVar);

/**
 * Reads the vault → sha256(token) mapping. `vaultsCsv` is EMBED_VAULTS (e.g. "anna,ben,firma" or
 * "v01,…,v30,firma"). Per vault exactly one of EMBED_TOKEN_SHA256_<VAULT> (64 hex characters) or
 * EMBED_TOKEN_<VAULT> (plain, 32–512 printable characters, hashed here) must be set. Only hashes are
 * kept; errors never contain token values.
 */
export function parseTokenConfig(vaultsCsv: string, env: Record<string, string | undefined>): Map<string, string> {
  const vaults = vaultsCsv.split(',').map((v) => v.trim()).filter(Boolean);
  if (vaults.length === 0) throw new Error('EMBED_VAULTS is empty');
  // Defence in depth for the naming rule above: no vault's plain variable may be another's hash variable.
  const hashVars = new Set(vaults.map(tokenHashVar));
  for (const v of vaults) {
    if (hashVars.has(tokenPlainVar(v))) throw new Error(`vault name ${v} collides with another vault's EMBED_TOKEN_SHA256_ variable`);
  }
  const tokens = new Map<string, string>();
  const seen = new Set<string>();
  for (const vault of vaults) {
    if (!VAULT_RE.test(vault) || vault.length > 63) throw new Error(`invalid vault name in EMBED_VAULTS: ${vault}`);
    if (tokens.has(vault)) throw new Error(`duplicate vault in EMBED_VAULTS: ${vault}`);
    const hashName = tokenHashVar(vault);
    const plainName = tokenPlainVar(vault);
    const hashed = (env[hashName] ?? '').trim();
    const plain = env[plainName] ?? '';
    if (hashed && plain) throw new Error(`both ${plainName} and ${hashName} are set; set only one`);
    let hash: string;
    if (plain) {
      if (!isStrongPlainToken(plain)) {
        throw new Error(`${plainName} must be a random token: 64+ hex characters (openssl rand -hex 32) or 32–512 random printable characters without spaces (e.g. 32+ random letters and digits)`);
      }
      hash = createHash('sha256').update(plain, 'utf8').digest('hex');
    } else {
      hash = hashed.toLowerCase();
      if (!SHA256_RE.test(hash)) throw new Error(`${hashName} (sha256 hex digest) or ${plainName} is required`);
    }
    if (seen.has(hash)) throw new Error(`two vaults use the same token (${vault})`);
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

/** An IPv4 network as a 32-bit base address and prefix length. */
export interface Ipv4Net { base: number; bits: number }

const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
};
const mask = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/**
 * Optional source binding: EMBED_SOURCE_<VAULT>=<cidr>[,<cidr>…] (the vault's own embed network).
 * A vault's token is then accepted only from those addresses, so a token that leaks to another vault
 * is useless there. Vaults without the variable are not bound.
 */
export function parseSourceConfig(vaults: readonly string[], env: Record<string, string | undefined>): Map<string, Ipv4Net[]> {
  const out = new Map<string, Ipv4Net[]>();
  for (const vault of vaults) {
    const name = `EMBED_SOURCE_${envSuffix(vault)}`;
    const raw = env[name];
    if (raw === undefined) continue;
    const nets = raw.split(',').map((c) => c.trim()).map((cidr) => {
      const m = /^([\d.]+)\/(\d{1,2})$/.exec(cidr);
      const base = m ? ipv4(m[1]!) : null;
      const bits = m ? Number(m[2]) : -1;
      if (base === null || bits < 0 || bits > 32 || (base & mask(bits)) >>> 0 !== base) {
        throw new Error(`${name} must be a comma-separated list of IPv4 networks (a.b.c.d/nn)`);
      }
      return { base, bits };
    });
    out.set(vault, nets);
  }
  return out;
}

/** True if the (possibly IPv4-mapped IPv6) address lies in one of the networks. */
export function inNetworks(address: string | undefined, nets: readonly Ipv4Net[]): boolean {
  const ip = ipv4((address ?? '').replace(/^::ffff:/i, ''));
  if (ip === null) return false;
  return nets.some((n) => (ip & mask(n.bits)) >>> 0 === n.base);
}
