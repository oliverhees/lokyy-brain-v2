// Entry point of the shared embedding service (LBV2-26). Configuration only via environment:
//   EMBED_VAULTS=anna,ben,firma and EMBED_TOKEN_SHA256_<VAULT>=sha256(token) per vault (required),
//   EMBED_SOURCE_<VAULT>=<cidr>[,…] (optional: accept that vault's token only from its own network)
//   EMBED_MODELS_DIR (default /models, read-only), EMBED_TRANSFORMERS_FROM (where @xenova/transformers
//   is resolved from, default the vault image's /app/apps/server/), EMBED_PORT (default 8080), limits below.
// Loads BGE-M3 once, offline, with the same pooling and normalisation as the in-process vault embedder.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { configureTransformersEnv, parseSourceConfig, parseTokenConfig, type Ipv4Net, type TransformersEnv } from './config.ts';
import { createEmbedService } from './service.ts';

export const MODEL_ID = 'Xenova/bge-m3';
/** Must match the vault's in-process embedder (apps/server/src/lib/embedder.ts). */
export const EMBED_OPTIONS = { pooling: 'mean', normalize: true } as const;

interface FeatureExtractor {
  (text: string, options: typeof EMBED_OPTIONS): Promise<{ data: Float32Array }>;
}
interface TransformersModule {
  env: TransformersEnv;
  pipeline: (task: 'feature-extraction', model: string) => Promise<FeatureExtractor>;
}

const log = (line: string) => console.log(line.startsWith('20') ? line : `${new Date().toISOString()} ${line}`);
const fatal = (msg: string): never => { console.error(`fatal: ${msg}`); process.exit(1); };
const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fatal(`${name} must be a positive number`);
};

let tokens: Map<string, string>;
let sources: Map<string, Ipv4Net[]>;
try {
  tokens = parseTokenConfig(process.env.EMBED_VAULTS ?? '', process.env);
  sources = parseSourceConfig([...tokens.keys()], process.env);
} catch (e) {
  fatal((e as Error).message);
}

const maxTexts = int('EMBED_MAX_TEXTS', 32);
const burst = int('EMBED_BURST', 200);
if (burst < maxTexts) fatal('EMBED_BURST must be at least EMBED_MAX_TEXTS');

let embedOne: ((text: string) => Promise<Float32Array>) | null = null;
let dim = 1024;
const server = createEmbedService({
  tokens: tokens!,
  sources: sources!,
  embedOne: (text) => embedOne!(text),
  get dim() { return dim; },
  maxTexts,
  maxChars: int('EMBED_MAX_CHARS', 8000),
  maxBodyBytes: int('EMBED_MAX_BODY_BYTES', 1024 * 1024),
  ratePerSec: int('EMBED_RATE_PER_SEC', 20),
  burst,
  maxPendingPerVault: int('EMBED_MAX_PENDING_PER_VAULT', 4),
  maxQueue: int('EMBED_MAX_QUEUE', 64),
  queueTimeoutMs: int('EMBED_QUEUE_TIMEOUT_MS', 30_000),
  isReady: () => embedOne !== null,
  log,
});
const port = int('EMBED_PORT', 8080);
server.listen(port, '0.0.0.0', () => log(`embed listening on :${port} for ${[...tokens!.keys()].join(',')}`));

try {
  const require = createRequire(process.env.EMBED_TRANSFORMERS_FROM ?? '/app/apps/server/');
  const t = (await import(pathToFileURL(require.resolve('@xenova/transformers')).href)) as TransformersModule;
  configureTransformersEnv(t.env, process.env.EMBED_MODELS_DIR ?? '/models');
  const extractor = await t.pipeline('feature-extraction', MODEL_ID);
  const run = async (text: string) => (await extractor(text, EMBED_OPTIONS)).data;
  dim = (await run('warm-up')).length;
  embedOne = run;
  log(`model ${MODEL_ID} loaded offline, dim=${dim}`);
} catch {
  // Generic on purpose: the model path and file names stay out of the log.
  fatal(`model ${MODEL_ID} could not be loaded from the local models directory`);
}
