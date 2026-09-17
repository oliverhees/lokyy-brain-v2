// One-shot model prefetch (M3): downloads the embedding model into the shared `models` volume,
// which every vault mounts read-only. Runs in the vault image as user vault; exits non-zero if the
// download fails, so vaults do not start with a missing model.
// Must load exactly what the vault loads: apps/server/src/lib/embedder.ts →
// pipeline('feature-extraction', 'Xenova/bge-m3') with the library defaults (quantized).
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/server/');
const { pipeline } = await import(require.resolve('@xenova/transformers'));

const started = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3');
const out = await extractor('lokyy model prefetch', { pooling: 'mean', normalize: true });
console.log(`model Xenova/bge-m3 ready in /models (dim ${out.data.length}, ${Math.round((Date.now() - started) / 1000)} s)`);
