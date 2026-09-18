// Shared embedding service (LBV2-26): one BGE-M3 instance for every vault on a server.
// API: POST /embed {"texts": string[]} → {"vectors": number[][], "dim": number}; GET /healthz.
// Order of checks, all before any inference: path (404) → method (405) → bearer token of a
// configured vault (401) → model loaded (503) → JSON content type (415) → body size (413, also
// while streaming) → body shape and limits (400) → the vault's pending-request cap (429) → global
// queue cap (503) → the vault's text rate (429 + Retry-After). Texts are embedded one at a time,
// round-robin across vaults, so one vault cannot starve the others. Error bodies are static; logs
// carry the vault name, counts, status and duration, never text content or token material.
// The service makes no outbound connections and forwards nothing.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface EmbedServiceOptions {
  tokens: ReadonlyMap<string, string>;   // vault → sha256(token) hex
  embedOne: (text: string) => Promise<ArrayLike<number>>;
  dim: number;
  maxTexts: number;          // texts per request
  maxChars: number;          // characters (UTF-16 code units) per text
  maxBodyBytes: number;
  ratePerSec: number;        // texts per second per vault (refill)
  burst: number;             // texts per vault (bucket size)
  maxPendingPerVault: number; // queued + running requests per vault
  maxQueue: number;          // queued + running requests overall
  queueTimeoutMs: number;    // a request not started within this time gets 503
  isReady: () => boolean;
  log: (line: string) => void;
  maxConnections?: number;   // default 256
  requestTimeoutMs?: number; // receiving the whole request, default 30 s
  headersTimeoutMs?: number; // default 10 s
}

const BODIES = {
  bad_request: '{"error":"bad_request"}',
  busy: '{"error":"busy"}',
  internal: '{"error":"internal"}',
  method_not_allowed: '{"error":"method_not_allowed"}',
  not_found: '{"error":"not_found"}',
  rate_limited: '{"error":"rate_limited"}',
  too_large: '{"error":"too_large"}',
  unauthorized: '{"error":"unauthorized"}',
  unavailable: '{"error":"unavailable"}',
  unsupported_media_type: '{"error":"unsupported_media_type"}',
} as const;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

class HttpError extends Error {
  readonly status: number;
  readonly body: keyof typeof BODIES;
  readonly retryAfter: number | undefined;
  constructor(status: number, body: keyof typeof BODIES, retryAfter?: number) {
    super(body);
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** Returns the vault whose token hash matches; compares against every vault (no early exit). */
function vaultFor(req: http.IncomingMessage, tokens: ReadonlyMap<string, string>): string | null {
  const m = /^bearer ([\x21-\x7e]{1,512})$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const presented = Buffer.from(hashToken(m[1]!), 'hex');
  let found: string | null = null;
  for (const [vault, hash] of tokens) {
    if (timingSafeEqual(presented, Buffer.from(hash, 'hex')) && found === null) found = vault;
  }
  return found;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; reject(new HttpError(413, 'too_large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'bad_request')); } });
  });
}

function parseTexts(raw: Buffer, maxTexts: number, maxChars: number): string[] {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_request'); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'texts') throw new HttpError(400, 'bad_request');
  const texts = (body as { texts: unknown }).texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > maxTexts) throw new HttpError(400, 'bad_request');
  for (const t of texts) {
    if (typeof t !== 'string' || t.length > maxChars) throw new HttpError(400, 'bad_request');
  }
  return texts as string[];
}

class Bucket {
  private tokens: number;
  private last = Date.now();
  private readonly rate: number;
  private readonly size: number;
  constructor(rate: number, size: number) { this.rate = rate; this.size = size; this.tokens = size; }
  /** Takes n tokens and returns 0, or returns the seconds until n tokens are available. */
  take(n: number): number {
    const now = Date.now();
    this.tokens = Math.min(this.size, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (n <= this.tokens) { this.tokens -= n; return 0; }
    if (n > this.size || this.rate <= 0) return 60;
    return Math.max(1, Math.ceil((n - this.tokens) / this.rate));
  }
}

interface Job {
  vault: string;
  texts: string[];
  vectors: number[][];
  started: boolean;
  cancelled: boolean;
  timer: NodeJS.Timeout;
  settle: (err: HttpError | null) => void;
}

export function createEmbedService(o: EmbedServiceOptions): http.Server {
  const queues = new Map<string, Job[]>();
  const rotation: string[] = [];   // vaults with pending jobs, in service order
  const buckets = new Map<string, Bucket>();
  let total = 0;
  let current: string | null = null;

  const remove = (job: Job) => {
    const q = queues.get(job.vault);
    const i = q?.indexOf(job) ?? -1;
    if (q && i >= 0) { q.splice(i, 1); total -= 1; clearTimeout(job.timer); }
    if (q && q.length === 0) {
      queues.delete(job.vault);
      const r = rotation.indexOf(job.vault);
      if (r >= 0) rotation.splice(r, 1);
    }
  };

  async function pump(): Promise<void> {
    if (current !== null) return;
    while (rotation.length > 0) {
      const vault = rotation.shift()!;
      const job = queues.get(vault)?.[0];
      if (!job) continue;
      current = vault;
      if (!job.cancelled) {
        job.started = true;
        clearTimeout(job.timer);
        try {
          const v = Array.from(await o.embedOne(job.texts[job.vectors.length]!));
          if (v.length !== o.dim || !v.every(Number.isFinite)) throw new Error('dimension');
          job.vectors.push(v);
        } catch {
          job.cancelled = true;
          job.settle(new HttpError(500, 'internal'));
        }
      }
      if (job.cancelled || job.vectors.length === job.texts.length) {
        remove(job);
        if (!job.cancelled) job.settle(null);
      }
      current = null;
      if (queues.has(vault) && !rotation.includes(vault)) rotation.push(vault);
    }
  }

  function enqueue(vault: string, texts: string[], res: http.ServerResponse): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        vault, texts, vectors: [], started: false, cancelled: false,
        timer: setTimeout(() => {
          if (job.started) return;
          job.cancelled = true;
          remove(job);
          reject(new HttpError(503, 'busy'));
        }, o.queueTimeoutMs),
        settle: (err) => (err ? reject(err) : resolve(job.vectors)),
      };
      // Client went away: drop the texts that were not embedded yet.
      res.on('close', () => {
        if (res.writableFinished || job.cancelled) return;
        job.cancelled = true;
        if (!job.started || current !== vault) remove(job);
      });
      const q = queues.get(vault) ?? [];
      q.push(job);
      queues.set(vault, q);
      total += 1;
      if (current !== vault && !rotation.includes(vault)) rotation.push(vault);
      void pump();
    });
  }

  const send = (res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(body);
  };

  async function handleEmbed(req: http.IncomingMessage, res: http.ServerResponse, vault: string): Promise<number> {
    if (!o.isReady()) throw new HttpError(503, 'unavailable');
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > o.maxBodyBytes) throw new HttpError(413, 'too_large');
    const texts = parseTexts(await readBody(req, o.maxBodyBytes), o.maxTexts, o.maxChars);
    if ((queues.get(vault)?.length ?? 0) >= o.maxPendingPerVault) throw new HttpError(429, 'rate_limited', 1);
    if (total >= o.maxQueue) throw new HttpError(503, 'busy');
    let bucket = buckets.get(vault);
    if (!bucket) { bucket = new Bucket(o.ratePerSec, o.burst); buckets.set(vault, bucket); }
    const wait = bucket.take(texts.length);
    if (wait > 0) throw new HttpError(429, 'rate_limited', wait);
    const vectors = await enqueue(vault, texts, res);
    send(res, 200, JSON.stringify({ vectors, dim: o.dim }));
    return texts.length;
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') {
      send(res, o.isReady() ? 200 : 503, o.isReady() ? '{"status":"ok"}' : BODIES.unavailable);
      return;
    }
    const vault = path === '/embed' ? vaultFor(req, o.tokens) : null;
    const finish = (status: number, texts: number) =>
      o.log(`${new Date().toISOString()} vault=${vault ?? '-'} texts=${texts} status=${status} ms=${Date.now() - t0}`);
    const fail = (e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal');
      send(res, err.status, BODIES[err.body], err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});
      // Unread request bodies must not keep the connection busy.
      if (!req.complete) req.resume();
      finish(err.status, 0);
    };
    if (path !== '/embed') return fail(new HttpError(404, 'not_found'));
    if (req.method !== 'POST') return fail(new HttpError(405, 'method_not_allowed'));
    if (!vault) return fail(new HttpError(401, 'unauthorized'));
    handleEmbed(req, res, vault).then((n) => finish(200, n), fail);
  });
  server.maxConnections = o.maxConnections ?? 256;
  server.requestTimeout = o.requestTimeoutMs ?? 30_000;
  server.headersTimeout = o.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
