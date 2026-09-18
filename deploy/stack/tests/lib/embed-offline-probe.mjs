// Runs in a one-off container of the embed image (no network, /models read-only, offline.mjs loaded):
// the service's own transformers configuration must report allowRemoteModels=false and still load
// BGE-M3 from /models; a model that is not in the cache must fail instead of being downloaded.
// Prints: "allowRemote=<bool> dim=<n> unlisted=<refused|LOADED>".
import { createRequire } from 'node:module';
import { configureTransformersEnv } from '/app/embed/src/config.ts';

const require = createRequire('/app/apps/server/');
const { pipeline, env } = await import(require.resolve('@xenova/transformers'));
configureTransformersEnv(env, '/models');
const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3');
const out = await extractor('offline probe', { pooling: 'mean', normalize: true });
let unlisted = 'LOADED';
try { await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); } catch { unlisted = 'refused'; }
console.log(`allowRemote=${env.allowRemoteModels} dim=${out.data.length} unlisted=${unlisted}`);
