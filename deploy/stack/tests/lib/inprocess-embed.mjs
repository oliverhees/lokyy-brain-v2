// In-process reference for tests/embed.sh: embeds each text of the JSON array on stdin exactly like the
// vault's in-process embedder (apps/server/src/lib/embedder.ts: slice 8000, mean pooling, normalized)
// and prints {"vectors": [...]} . Runs in a one-off vault-image container, offline, /models read-only.
import { createRequire } from 'node:module';

const require = createRequire('/app/apps/server/');
const { pipeline, env } = await import(require.resolve('@xenova/transformers'));
env.allowRemoteModels = false;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const texts = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const fx = await pipeline('feature-extraction', 'Xenova/bge-m3');
const vectors = [];
for (const t of texts) vectors.push(Array.from((await fx(t.slice(0, 8000), { pooling: 'mean', normalize: true })).data));
console.log(JSON.stringify({ vectors }));
