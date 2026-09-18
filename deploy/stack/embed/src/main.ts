// Entry point of the shared embedding service (LBV2-26). Configuration only via environment:
//   EMBED_VAULTS=anna,ben,firma and per vault EMBED_TOKEN_SHA256_<VAULT>=sha256(token) or EMBED_TOKEN_<VAULT>=token,
//   EMBED_SOURCE_<VAULT>=<cidr>[,…] (optional: accept that vault's token only from its own network)
//   EMBED_MODELS_DIR (default /models, read-only), EMBED_TRANSFORMERS_FROM (where @xenova/transformers
//   is resolved from, default the vault image's /app/apps/server/), EMBED_PORT (default 8080), limits below.
// Loads BGE-M3 once, offline, with the same pooling and normalisation as the in-process vault embedder.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { configureTransformersEnv, parseSourceConfig, parseTokenConfig, plainTokenVars, type Ipv4Net, type TransformersEnv } from './config.ts';
import { createEmbedService } from './service.ts';

export const MODEL_ID = 'Xenova/bge-m3';
/** Must match the vault's in-process embedder (apps/server/src/lib/embedder.ts). */
export const EMBED_OPTIONS = { pooling: 'mean', normalize: true } as const;

interface FeatureExtractor {
  (text: string, options: typeof EMBED_OPTIONS): Promise<{ data: Float32Array }>;
  tokenizer: { model_max_length: number; encode: (text: string) => number[] };
}
interface OrtModule {
  InferenceSession: { create: (model: unknown, options?: Record<string, unknown>) => Promise<unknown> };
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
// Only hashes are kept: plain tokens leave process.env (the container's initial environment in
// /proc/1/environ cannot be changed; prefer EMBED_TOKEN_SHA256_<VAULT> where the platform allows).
for (const name of plainTokenVars([...tokens!.keys()])) delete process.env[name];

const maxTexts = int('EMBED_MAX_TEXTS', 16);
// Audit HIGH-2: attention memory grows with tokens², and 8000 characters can be ~8000 tokens (CJK,
// symbols). Every text is truncated to this many tokens by the tokenizer (same cap as the vault's
// in-process embedder, packages/core EMBED_MAX_TOKENS), and a request may carry at most
// EMBED_MAX_REQUEST_TOKENS tokens after truncation.
const maxTokens = int('EMBED_MAX_TOKENS', 2048);
const maxRequestTokens = int('EMBED_MAX_REQUEST_TOKENS', 8192);
const burst = int('EMBED_BURST', 200);
if (burst < maxTexts) fatal('EMBED_BURST must be at least EMBED_MAX_TEXTS');

let embedOne: ((text: string) => Promise<Float32Array>) | null = null;
let countTokens: ((text: string) => number) | null = null;
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
  countTokens: (text) => countTokens!(text),
  maxRequestTokens,
  priorityMaxChars: int('EMBED_PRIORITY_MAX_CHARS', 512),
  inferenceTimeoutMs: int('EMBED_INFERENCE_TIMEOUT_MS', 60_000),
  // A stuck ONNX run cannot be aborted: exit so the container restarts (restart: unless-stopped);
  // vaults fall back to keyword search meanwhile.
  onStuck: () => fatal('inference did not finish in time; restarting'),
});
const port = int('EMBED_PORT', 8080);
server.listen(port, '0.0.0.0', () => log(`embed listening on :${port} for ${[...tokens!.keys()].join(',')}`));

try {
  const require = createRequire(process.env.EMBED_TRANSFORMERS_FROM ?? '/app/apps/server/');
  const transformersPath = require.resolve('@xenova/transformers');
  // Audit HIGH-2 (memory): ONNX Runtime's CPU arena keeps the largest buffers of every sequence length
  // seen and never returns them, so memory climbs with varied input lengths. Off by default here;
  // transformers.js does not pass session options, so they are added to InferenceSession.create.
  if (process.env.EMBED_ONNX_ARENA !== '1') {
    const ort = createRequire(transformersPath)('onnxruntime-node') as OrtModule;
    const create = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = (model, options) => create(model, { ...options, enableCpuMemArena: false, enableMemPattern: false });
  }
  const t = (await import(pathToFileURL(transformersPath).href)) as TransformersModule;
  configureTransformersEnv(t.env, process.env.EMBED_MODELS_DIR ?? '/models');
  const extractor = await t.pipeline('feature-extraction', MODEL_ID);
  extractor.tokenizer.model_max_length = maxTokens;
  countTokens = (text) => Math.min(extractor.tokenizer.encode(text).length, maxTokens);
  const run = async (text: string) => (await extractor(text, EMBED_OPTIONS)).data;
  dim = (await run('warm-up')).length;
  embedOne = run;
  log(`model ${MODEL_ID} loaded offline, dim=${dim}, max ${maxTokens} tokens per text`);
} catch {
  // Generic on purpose: the model path and file names stay out of the log.
  fatal(`model ${MODEL_ID} could not be loaded from the local models directory`);
}
