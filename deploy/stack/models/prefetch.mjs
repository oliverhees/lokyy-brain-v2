// One-shot model prefetch (M3, LOW-3): fills the shared `models` volume that every vault mounts
// read-only, from a pinned Hugging Face revision, and verifies every file against the SHA-256
// manifest (manifest.json, next to this script). Runs on every `docker compose up`; vaults depend on
// its success, so a missing, changed or tampered model file keeps the vaults from starting.
// Must load what the vault loads: apps/server/src/lib/embedder.ts → pipeline('feature-extraction',
// 'Xenova/bge-m3') with library defaults (quantized). PREFETCH_VERIFY_ONLY=1 skips the download.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const root = join(process.env.MODELS_DIR ?? '/models', manifest.model);

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
async function verify() {
  const problems = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = join(root, name);
    if (!existsSync(file)) { problems.push(`missing ${name}`); continue; }
    const actual = await sha256(file);
    if (actual !== expected) problems.push(`checksum mismatch ${name}`);
  }
  return problems;
}

let problems = await verify();
if (problems.length && process.env.PREFETCH_VERIFY_ONLY !== '1' && !problems.some((p) => p.startsWith('checksum mismatch'))) {
  const require = createRequire('/app/apps/server/');
  const { pipeline } = await import(require.resolve('@xenova/transformers'));
  const started = Date.now();
  const extractor = await pipeline('feature-extraction', manifest.model, { revision: manifest.revision });
  const out = await extractor('lokyy model prefetch', { pooling: 'mean', normalize: true });
  console.log(`downloaded ${manifest.model}@${manifest.revision.slice(0, 12)} (dim ${out.data.length}, ${Math.round((Date.now() - started) / 1000)} s)`);
  problems = await verify();
}
if (problems.length) {
  // A changed file is never "repaired" by re-downloading over it: somebody has to look at it.
  console.error(`model verification FAILED: ${problems.join(', ')}`);
  process.exit(1);
}
console.log(`model ${manifest.model}@${manifest.revision.slice(0, 12)} verified (${Object.keys(manifest.files).length} files, sha256)`);
