#!/usr/bin/env node
// apps/mcp/src/http.ts
// Serves the MindBase MCP server over Streamable HTTP for self-hosted deployments,
// so an aggregator (e.g. MetaMCP) can reach a vault over an internal network
// without mounting the vault's data directory itself.
//
// Env:
//   MCP_HTTP_TOKEN            required, >= 32 chars; clients send `Authorization: Bearer <token>`
//   MCP_HTTP_READONLY_TOKEN   optional, >= 32 chars, different from MCP_HTTP_TOKEN; sessions opened
//                             with it only see and call tools on the READ_ONLY_TOOL_NAMES allowlist
//                             and never see pages with visibility internal/pii
//   MCP_HTTP_PORT             default 4322
//   MCP_HTTP_HOST             default 0.0.0.0
//   MCP_HTTP_MAX_SESSIONS     default 32; cap for full-profile sessions; when full, the least recently
//                             used full session is evicted
//   MCP_HTTP_MAX_READONLY_SESSIONS  default = MCP_HTTP_MAX_SESSIONS; separate cap for read-only sessions,
//                             so the two profiles can never evict each other
//   MCP_HTTP_SESSION_IDLE_MS  default 1800000 (30 min), min 1000; idle sessions are closed
//   MCP_HTTP_ALLOWED_HOSTS    optional comma-separated Host header allow-list (e.g. vault-anna:4322)
import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadContext } from './context.js';
import { createMcpServer } from './index.js';
import type { AccessProfile } from './access.js';

const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function log(msg: string): void {
  process.stderr.write(`[mindbase-mcp-http] ${msg}\n`);
}

/** Parses an integer env var; exits on garbage so NaN can never silently disable a limit. */
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    log(`fatal: ${name} must be an integer >= ${min} (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Resolves the bearer token to an access profile; constant-time against every configured token. */
function profileFor(header: string | undefined, tokens: ReadonlyArray<[Buffer, AccessProfile]>): AccessProfile | null {
  if (!header?.startsWith('Bearer ')) return null;
  const given = sha256(header.slice('Bearer '.length));
  let match: AccessProfile | null = null;
  for (const [want, profile] of tokens) {
    if (timingSafeEqual(given, want)) match = profile;
  }
  return match;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sendJson(res: http.ServerResponse, status: number, message: string, code = -32000): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Payload too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : undefined;
}

async function main(): Promise<void> {
  const token = process.env['MCP_HTTP_TOKEN'] ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    log(`fatal: MCP_HTTP_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters`);
    process.exit(1);
  }
  const readonlyToken = process.env['MCP_HTTP_READONLY_TOKEN'] ?? '';
  if (readonlyToken && readonlyToken.length < MIN_TOKEN_LENGTH) {
    log(`fatal: MCP_HTTP_READONLY_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
    process.exit(1);
  }
  if (readonlyToken && readonlyToken === token) {
    log('fatal: MCP_HTTP_READONLY_TOKEN must differ from MCP_HTTP_TOKEN');
    process.exit(1);
  }
  const tokens: Array<[Buffer, AccessProfile]> = [[sha256(token), 'full']];
  if (readonlyToken) tokens.push([sha256(readonlyToken), 'readonly']);
  const port = intEnv('MCP_HTTP_PORT', 4322, 1);
  const host = process.env['MCP_HTTP_HOST'] ?? '0.0.0.0';
  const maxSessions = intEnv('MCP_HTTP_MAX_SESSIONS', 32, 1);
  const maxReadonlySessions = intEnv('MCP_HTTP_MAX_READONLY_SESSIONS', maxSessions, 1);
  const capFor = (p: AccessProfile): number => (p === 'full' ? maxSessions : maxReadonlySessions);
  const idleMs = intEnv('MCP_HTTP_SESSION_IDLE_MS', 30 * 60 * 1000, 1000);
  const allowedHosts = (process.env['MCP_HTTP_ALLOWED_HOSTS'] ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

  // Remote clients must not make the server read its own filesystem.
  const ctx = { ...(await loadContext({})), allowLocalFilePaths: false };

  interface Session { transport: StreamableHTTPServerTransport; lastSeen: number; inFlight: number; profile: AccessProfile }
  const sessions = new Map<string, Session>();
  // Sessions still initializing count toward their profile's cap so concurrent initializes cannot overshoot it.
  const pending: Record<AccessProfile, number> = { full: 0, readonly: 0 };
  const countFor = (p: AccessProfile): number => {
    let n = pending[p];
    for (const s of sessions.values()) if (s.profile === p) n++;
    return n;
  };

  const closeSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
  };

  /** Evicts the profile's least recently used session with no request in flight; false if none is evictable. */
  const evictLeastRecentlyUsed = (p: AccessProfile): boolean => {
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) {
      if (entry[1].profile !== p || entry[1].inFlight > 0) continue;
      if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
    }
    if (!oldest) return false;
    log(`session cap reached, evicting ${oldest[0]}`);
    closeSession(oldest[0]);
    return true;
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) {
      if (s.inFlight === 0 && s.lastSeen < cutoff) {
        log(`closing idle session ${id}`);
        closeSession(id);
      }
    }
  }, Math.max(250, Math.min(idleMs / 2, 60_000)));
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const profile = profileFor(req.headers.authorization, tokens);
      if (!profile) {
        sendJson(res, 401, 'Unauthorized');
        return;
      }
      if (allowedHosts.length > 0 && !allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
        sendJson(res, 403, 'Forbidden host');
        return;
      }
      if (url.pathname !== '/mcp') {
        sendJson(res, 404, 'Not found');
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (sessionId !== undefined && !session) {
        // Spec: an unknown session must answer 404 so the client re-initializes.
        sendJson(res, 404, 'Session not found', -32001);
        return;
      }
      if (session && session.profile !== profile) {
        // A session keeps the access profile of the token that opened it.
        sendJson(res, 403, 'Forbidden: token does not match session');
        return;
      }
      if (session) {
        session.lastSeen = Date.now();
        // Only request/response calls pin a session. A GET is the long-lived notification
        // stream every client keeps open; counting it would make sessions unevictable.
        if (req.method !== 'GET') {
          session.inFlight++;
          res.once('close', () => { session.inFlight--; session.lastSeen = Date.now(); });
        }
      }
      const existing = session?.transport;

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, 'Bad Request: no valid session');
          return;
        }
        while (countFor(profile) >= capFor(profile) && evictLeastRecentlyUsed(profile)) { /* evict until room */ }
        if (countFor(profile) >= capFor(profile)) {
          sendJson(res, 503, 'Too many active sessions');
          return;
        }
        pending[profile]++;
        let registered = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            pending[profile]--;
            registered = true;
            sessions.set(id, { transport, lastSeen: Date.now(), inFlight: 0, profile });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        try {
          await createMcpServer(ctx, profile).connect(transport);
          await transport.handleRequest(req, res, body);
        } finally {
          if (!registered) pending[profile]--;
        }
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!existing) {
          sendJson(res, 400, 'Bad Request: no valid session');
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, 'Method not allowed');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      log(`request error (${status}): ${(e as Error).message}`);
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
        sendJson(res, status, status === 413 ? 'Payload too large' : 'Bad Request');
      }
      if (status === 413) res.once('finish', () => req.destroy());
    }
  });

  server.listen(port, host, () => {
    log(`listening on http://${host}:${port}/mcp · dataDir=${ctx.dataDir}`);
  });

  const shutdown = () => {
    clearInterval(sweep);
    for (const id of [...sessions.keys()]) closeSession(id);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
