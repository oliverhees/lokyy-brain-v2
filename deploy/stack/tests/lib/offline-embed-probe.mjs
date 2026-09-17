// Runs inside the vault image with NODE_OPTIONS=--import=/lokyy/offline.mjs and without network:
// transformers must report allowRemoteModels=false and still embed from the local /models cache.
// A second model that is not in the cache must fail instead of being downloaded.
// Prints: "allowRemote=<bool> dim=<n> unlisted=<refused|LOADED>".
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/server/');
const { pipeline, env } = await import(require.resolve('@xenova/transformers'));
const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3');
const out = await extractor('offline probe', { pooling: 'mean', normalize: true });
let unlisted = 'LOADED';
try { await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); } catch { unlisted = 'refused'; }
console.log(`allowRemote=${env.allowRemoteModels} dim=${out.data.length} unlisted=${unlisted}`);
