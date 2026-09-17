// mcp-gate: session-binding reverse proxy in front of MetaMCP (finding M2).
// Only POST/GET/DELETE on /metamcp/<name>/mcp are forwarded. Order of checks, all before the body is
// read: path + method (static 404) → a non-empty API key (static 401) → a presented mcp-session-id must
// be bound to the same key hash and endpoint (static 404). A POST without a session id is forwarded
// only if it is a single initialize request (static 400), within the key's initialize rate (429) and
// while the gate has room for the key's new session (503). Streams (GET) are limited per session and
// per key (429) and closed when their binding goes away. Bindings that are evicted or expire are
// also deleted in MetaMCP. Upstream error bodies are replaced, Location/Link headers dropped and a
// session id the gate did not bind is never handed out. Keys and session ids are never logged.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Bindings, type RemoveReason } from './bindings.ts';

export const STATIC_NOT_FOUND = '{"error":"not_found"}';
export const STATIC_UNAUTHORIZED = '{"error":"unauthorized"}';
export const STATIC_BAD_REQUEST = '{"error":"bad_request"}';
export const STATIC_TOO_MANY = '{"error":"too_many_requests"}';
export const STATIC_ERROR_BODY = '{"error":"request_rejected"}';
/** Seconds a client should wait after a 429 (initialize rate refills 1 token/s; streams free up on close). */
const RETRY_AFTER_SECONDS = 2;
const PATH_RE = /^\/metamcp\/([a-z0-9][a-z0-9-]{0,63})\/mcp$/;
const METHODS = new Set(['POST', 'GET', 'DELETE']);
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];
// Response headers never passed to clients: hop-by-hop, the session id (set explicitly), and URLs
// pointing into the stack.
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'mcp-session-id', 'location', 'content-location', 'link']);

export interface GateOptions {
  upstream: string;          // e.g. http://metamcp:12008
  idleMs: number;            // binding idle timeout (an open stream counts as activity)
  lifetimeMs: number;        // binding absolute lifetime
  maxBindings: number;       // global cap (fail closed for new keys), see globalBindingCap()
  maxPerKey?: number;        // per-key cap (own oldest evicted), default 20
  maxBodyBytes: number;
  maxConnections?: number;   // default 512
  requestTimeoutMs?: number; // whole request incl. body, default 30 s (SSE responses are not affected)
  headersTimeoutMs?: number; // default 10 s
  keepAliveTimeoutMs?: number; // default 5 s
  sseIdleMs?: number;        // an open response without any bytes for this long is closed, default 15 min
  checkIntervalMs?: number;  // how often Node checks request/headers timeouts, default 1 s
  sweepIntervalMs?: number;  // how often expired bindings are removed, default 60 s
  initRatePerSec?: number;   // initialize requests per key, refill rate, default 1/s
  initBurst?: number;        // initialize burst per key, default 5
  maxStreamsPerSession?: number; // open GET streams per session, default 2
  maxStreamsPerKey?: number; // open GET streams per key, default 10
  log: (line: string) => void;
}

/** Global binding cap for a number of provisioned users: users × per-key cap × 1.25, at least 100. */
export function globalBindingCap(users: number, perKey: number): number {
  return Math.max(100, Math.ceil(users * perKey * 1.25));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tag = (s: string) => sha256(s).slice(0, 8); // loggable, not reversible

function apiKey(req: http.IncomingMessage): string {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7).trim()) return auth.slice(7).trim();
  return '';
}

/** Only one plain JSON-RPC object with method "initialize" may create a session (no batches). */
function isInitialize(body: Buffer): boolean {
  try {
    const msg: unknown = JSON.parse(body.toString('utf8'));
    return typeof msg === 'object' && msg !== null && !Array.isArray(msg) && (msg as { method?: unknown }).method === 'initialize';
  } catch {
    return false;
  }
}

function sendStatic(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: string, close = false): void {
  if (res.headersSent) { res.destroy(); return; }
  const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' };
  if (status === 429) headers['retry-after'] = String(RETRY_AFTER_SECONDS);
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(body);
  // Never read (or buffer) the body of a rejected request: drop the connection once the answer is out.
  if (close) res.on('finish', () => req.destroy());
}

class TokenBuckets {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #rate: number;
  readonly #burst: number;
  constructor(rate: number, burst: number) { this.#rate = rate; this.#burst = burst; }
  take(id: string, now = Date.now()): boolean {
    const b = this.#buckets.get(id) ?? { tokens: this.#burst, at: now };
    b.tokens = Math.min(this.#burst, b.tokens + ((now - b.at) / 1000) * this.#rate);
    b.at = now;
    this.#buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  prune(now = Date.now()): void {
    for (const [id, b] of this.#buckets) if (b.tokens + ((now - b.at) / 1000) * this.#rate >= this.#burst) this.#buckets.delete(id);
  }
}

export function createGate(opts: GateOptions): http.Server {
  const upstream = new URL(opts.upstream);
  const streams = new Map<string, Set<http.ServerResponse>>(); // session id → open GET responses
  const streamsPerKey = new Map<string, number>();
  const maxStreamsPerSession = opts.maxStreamsPerSession ?? 2;
  const maxStreamsPerKey = opts.maxStreamsPerKey ?? 10;
  const initBuckets = new TokenBuckets(opts.initRatePerSec ?? 1, opts.initBurst ?? 5);
  let warnedAt = 0;

  const bindings = new Bindings({
    idleMs: opts.idleMs,
    lifetimeMs: opts.lifetimeMs,
    max: opts.maxBindings,
    maxPerKey: opts.maxPerKey ?? 20,
    onRemove: (sid, owner, reason: RemoveReason) => {
      for (const res of streams.get(sid) ?? []) res.destroy();
      streams.delete(sid);
      if (reason !== 'unbound') {
        opts.log(`${reason} session=${tag(sid)} endpoint=${owner.endpoint}: deleting it in MetaMCP`);
        // MetaMCP routes a session by its id; the path only has to reach the endpoint router.
        deleteUpstreamFor(sid, owner.key, owner.endpoint);
      }
    },
  });
  const deleteUpstreamFor = (sid: string, key: string, endpoint: string) => {
    if (!key) return;
    const del = http.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: 'DELETE', path: `/metamcp/${endpoint}/mcp`, headers: { host: upstream.host, 'x-api-key': key, 'mcp-session-id': sid } }, (r) => r.resume());
    del.on('error', () => opts.log(`upstream delete failed session=${tag(sid)}`));
    del.setTimeout(10_000, () => del.destroy());
    del.end();
  };

  const sweeper = setInterval(() => {
    for (const sid of streams.keys()) bindings.touch(sid); // an open stream is activity
    bindings.sweep();
    initBuckets.prune();
  }, opts.sweepIntervalMs ?? 60_000);
  sweeper.unref();

  const warnIfFull = () => {
    if (bindings.size < bindings.max * 0.8) return;
    const now = Date.now();
    if (now - warnedAt < 60_000) return;
    warnedAt = now;
    opts.log(`WARN bindings ${bindings.size}/${bindings.max} (>= 80 %): new keys will be refused when full`);
  };

  const server = http.createServer({ connectionsCheckingInterval: opts.checkIntervalMs ?? 1000 }, (req, res) => {
    // Static error body for Traefik's errors middleware (not routed publicly).
    if (req.method === 'GET' && req.url === '/__error') { sendStatic(req, res, 200, STATIC_ERROR_BODY); return; }

    const path = (req.url ?? '').split('?')[0] ?? '';
    const match = PATH_RE.exec(path);
    const method = req.method ?? '';
    if (!match || !METHODS.has(method)) { sendStatic(req, res, 404, STATIC_NOT_FOUND, true); return; }
    const endpoint = match[1] as string;
    const key = apiKey(req);
    if (!key) { sendStatic(req, res, 401, STATIC_UNAUTHORIZED, true); return; }
    const keyHash = sha256(key);
    const sidHeader = req.headers['mcp-session-id'];
    const sid = typeof sidHeader === 'string' ? sidHeader : Array.isArray(sidHeader) ? ' invalid' : '';

    if (sid && !bindings.check(sid, keyHash, endpoint)) {
      opts.log(`reject session=${tag(sid)} endpoint=${endpoint} reason=unbound-or-mismatch`);
      sendStatic(req, res, 404, STATIC_NOT_FOUND, true);
      return;
    }
    if (!sid && method !== 'POST') { sendStatic(req, res, 400, STATIC_BAD_REQUEST, true); return; }

    if (method === 'GET') {
      const open = streams.get(sid) ?? new Set<http.ServerResponse>();
      if (open.size >= maxStreamsPerSession || (streamsPerKey.get(keyHash) ?? 0) >= maxStreamsPerKey) {
        sendStatic(req, res, 429, STATIC_TOO_MANY, true);
        return;
      }
      open.add(res);
      streams.set(sid, open);
      streamsPerKey.set(keyHash, (streamsPerKey.get(keyHash) ?? 0) + 1);
      res.on('close', () => {
        const set = streams.get(sid);
        set?.delete(res);
        if (set && set.size === 0) streams.delete(sid);
        const n = (streamsPerKey.get(keyHash) ?? 1) - 1;
        if (n > 0) streamsPerKey.set(keyHash, n); else streamsPerKey.delete(keyHash);
      });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > opts.maxBodyBytes) { tooLarge = true; chunks.length = 0; sendStatic(req, res, 413, STATIC_ERROR_BODY, true); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      const initialize = method === 'POST' && isInitialize(body);
      if (!sid && !initialize) { sendStatic(req, res, 400, STATIC_BAD_REQUEST); return; }
      if (!sid) {
        if (!initBuckets.take(keyHash)) {
          opts.log(`reject endpoint=${endpoint} key=${keyHash.slice(0, 8)} reason=initialize-rate`);
          sendStatic(req, res, 429, STATIC_TOO_MANY);
          return;
        }
        if (!bindings.hasCapacity(keyHash)) {
          opts.log(`reject endpoint=${endpoint} key=${keyHash.slice(0, 8)} reason=gate-full ${bindings.size}/${bindings.max}`);
          sendStatic(req, res, 503, STATIC_ERROR_BODY);
          return;
        }
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.includes(k) && v !== undefined) headers[k] = v;
      headers.host = upstream.host;
      if (body.length) headers['content-length'] = body.length;

      const up = http.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method, path, headers }, (upRes) => {
        const status = upRes.statusCode ?? 502;
        if (status >= 400) {
          upRes.resume();
          if (sid && (status === 401 || status === 404)) {
            // The key was rotated or removed, or MetaMCP no longer knows the session: forget the binding
            // and close its streams instead of keeping them until expiry.
            bindings.unbind(sid);
            opts.log(`drop session=${tag(sid)} endpoint=${endpoint} reason=upstream-${status}`);
          }
          sendStatic(req, res, status, STATIC_ERROR_BODY);
          return;
        }
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_RESPONSE.has(k) && v !== undefined) out[k] = v;
        const newSid = upRes.headers['mcp-session-id'];
        if (typeof newSid === 'string') {
          if (!sid && initialize) {
            if (bindings.bind(newSid, keyHash, endpoint, key)) {
              out['mcp-session-id'] = newSid;
              opts.log(`bind session=${tag(newSid)} endpoint=${endpoint} key=${keyHash.slice(0, 8)}`);
              warnIfFull();
            } else {
              upRes.resume();
              deleteUpstreamFor(newSid, key, endpoint);
              sendStatic(req, res, 503, STATIC_ERROR_BODY);
              return;
            }
          } else if (sid && newSid === sid) {
            out['mcp-session-id'] = sid; // the caller's own, already verified session
          }
          // any other id (e.g. initialize sent on an existing session) is never handed out
        }
        if (method === 'DELETE' && sid) { bindings.unbind(sid); opts.log(`unbind session=${tag(sid)} endpoint=${endpoint}`); }
        res.writeHead(status, out);
        res.flushHeaders();
        // Long-lived responses (SSE) are not limited by the request timeout, but closed when idle.
        upRes.setTimeout(opts.sseIdleMs ?? 15 * 60 * 1000, () => { upRes.destroy(); res.destroy(); });
        upRes.pipe(res);
      });
      up.on('error', () => sendStatic(req, res, 502, STATIC_ERROR_BODY));
      res.on('close', () => up.destroy());
      up.end(body);
    });
  });
  server.on('close', () => clearInterval(sweeper));
  server.maxConnections = opts.maxConnections ?? 512;
  server.requestTimeout = opts.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.min(opts.headersTimeoutMs ?? 10_000, server.requestTimeout);
  server.keepAliveTimeout = opts.keepAliveTimeoutMs ?? 5_000;
  return server;
}
