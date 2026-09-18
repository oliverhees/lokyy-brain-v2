/**
 * Client for the shared embedding service (LBV2-26, deploy/stack/embed).
 *
 * Hosted vaults set MINDBASE_EMBED_URL + MINDBASE_EMBED_TOKEN; the vault then never loads BGE-M3
 * in-process and sends texts to the service instead. The service runs the same model with the same
 * pooling and normalisation, so vectors are interchangeable with in-process ones (the embedding
 * cache stays valid). Without both variables nothing changes (local installs embed in-process).
 */

/** Characters per text, same cut as the in-process embedder (`text.slice(0, 8000)`). */
export const EMBED_MAX_CHARS = 8000;
/**
 * Tokens per text (audit LBV2-26 HIGH-2): attention memory grows with tokens², and 8000 characters
 * of CJK or symbols are up to ~8000 tokens. The shared service and the in-process embedders truncate
 * at this many tokens (tokenizer model_max_length), so their vectors stay identical. 8000 characters
 * of German or English prose are about 1800–2300 tokens; longer texts lose their tail.
 */
export const EMBED_MAX_TOKENS = 2048;
/** Retry-After values above this are clamped (the service is inside the stack, not trusted to park us). */
const MAX_RETRY_AFTER_MS = 10_000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export class EmbedServiceError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EmbedServiceError';
    this.status = status;
  }
}

export interface RemoteEmbedderOptions {
  /** Base URL of the service, e.g. http://embed:8080 (requests go to <url>/embed). */
  url: string;
  token: string;
  /** Per attempt, default 45 s (the service queues up to 30 s under load). */
  timeoutMs?: number;
  /** Additional attempts after the first on 429/502/503/504, timeouts and network errors, default 2. */
  retries?: number;
  /** First backoff; doubles per attempt, default 500 ms. */
  backoffMs?: number;
  /** Texts per request, default 16 (stays below the service's 1 MB body limit at 8000 chars each). */
  maxBatch?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RemoteEmbedder {
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseVectors(body: unknown, count: number): number[][] {
  const bad = () => new EmbedServiceError('embedding service returned an invalid response');
  if (typeof body !== 'object' || body === null) throw bad();
  const { vectors, dim } = body as { vectors?: unknown; dim?: unknown };
  if (!Array.isArray(vectors) || vectors.length !== count || typeof dim !== 'number' || dim <= 0) throw bad();
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== dim || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw bad();
  }
  return vectors as number[][];
}

export function createRemoteEmbedder(opts: RemoteEmbedderOptions): RemoteEmbedder {
  const endpoint = `${opts.url.replace(/\/+$/, '')}/embed`;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 500;
  const maxBatch = Math.max(1, opts.maxBatch ?? 16);
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = retries + 1;

  async function request(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ texts: texts.map((t) => t.slice(0, EMBED_MAX_CHARS)) });
    let last: EmbedServiceError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let wait = backoffMs * 2 ** attempt;
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
          body,
          // The token must never follow a redirect to another host.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        last = new EmbedServiceError(timedOut
          ? `embedding service timed out after ${timeoutMs} ms`
          : 'embedding service unreachable');
        if (attempt < attempts - 1) await sleep(wait);
        continue;
      }
      if (res.ok) {
        let parsed: unknown;
        try { parsed = await res.json(); } catch { throw new EmbedServiceError('embedding service returned an invalid response'); }
        return parseVectors(parsed, texts.length);
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401) {
        throw new EmbedServiceError('embedding service rejected the vault token (HTTP 401); check MINDBASE_EMBED_TOKEN', 401);
      }
      if (!RETRY_STATUS.has(res.status)) {
        throw new EmbedServiceError(`embedding service refused the request (HTTP ${res.status})`, res.status);
      }
      last = new EmbedServiceError(`embedding service unavailable (HTTP ${res.status})`, res.status);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
      if (attempt < attempts - 1) await sleep(wait);
    }
    const err = last ?? new EmbedServiceError('embedding service unavailable');
    throw new EmbedServiceError(`${err.message} after ${attempts} attempts`, err.status);
  }

  return {
    async embed(text) {
      return (await request([text]))[0]!;
    },
    async embedMany(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += maxBatch) out.push(...(await request(texts.slice(i, i + maxBatch))));
      return out;
    },
  };
}

function positiveInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/**
 * Remote embedder from MINDBASE_EMBED_URL + MINDBASE_EMBED_TOKEN (optional MINDBASE_EMBED_TIMEOUT_MS,
 * MINDBASE_EMBED_RETRIES), or null when neither is set. Exactly one of the two is a configuration
 * error: failing is safer than silently loading the model in-process on a server sized for the service.
 */
export function remoteEmbedderFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Pick<RemoteEmbedderOptions, 'fetchFn' | 'sleep'> = {},
): RemoteEmbedder | null {
  const url = env['MINDBASE_EMBED_URL']?.trim() ?? '';
  const token = env['MINDBASE_EMBED_TOKEN']?.trim() ?? '';
  if (!url && !token) return null;
  if (!url) throw new Error('MINDBASE_EMBED_TOKEN is set but MINDBASE_EMBED_URL is not');
  if (!token) throw new Error('MINDBASE_EMBED_URL is set but MINDBASE_EMBED_TOKEN is not');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('MINDBASE_EMBED_URL is not a valid URL'); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || url.includes('#')) {
    throw new Error('MINDBASE_EMBED_URL must be a plain http(s) URL without credentials, query or fragment');
  }
  return createRemoteEmbedder({
    url,
    token,
    timeoutMs: positiveInt(env, 'MINDBASE_EMBED_TIMEOUT_MS'),
    retries: positiveInt(env, 'MINDBASE_EMBED_RETRIES'),
    ...overrides,
  });
}
