#!/usr/bin/env node
// apps/mcp/src/http.ts
// Serves the MindBase MCP server over Streamable HTTP for self-hosted deployments,
// so an aggregator (e.g. MetaMCP) can reach a vault over an internal network
// without mounting the vault's data directory itself.
//
// Env:
//   MCP_HTTP_TOKEN            required, >= 32 chars; clients send `Authorization: Bearer <token>`
//   MCP_HTTP_PORT             default 4322
//   MCP_HTTP_HOST             default 0.0.0.0
//   MCP_HTTP_MAX_SESSIONS     default 32; when full, the least recently used session is evicted
//   MCP_HTTP_SESSION_IDLE_MS  default 1800000 (30 min); idle sessions are closed
//   MCP_HTTP_ALLOWED_HOSTS    optional comma-separated Host header allow-list (e.g. vault-anna:4322)
import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadContext } from './context.js';
import { createMcpServer } from './index.js';

const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function log(msg: string): void {
  process.stderr.write(`[mindbase-mcp-http] ${msg}\n`);
}

/** Constant-time token comparison; hashing first equalises lengths. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const want = createHash('sha256').update(expected).digest();
  return timingSafeEqual(given, want);
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
  const port = Number(process.env['MCP_HTTP_PORT'] ?? 4322);
  const host = process.env['MCP_HTTP_HOST'] ?? '0.0.0.0';
  const maxSessions = Math.max(1, Number(process.env['MCP_HTTP_MAX_SESSIONS'] ?? 32));
  const idleMs = Number(process.env['MCP_HTTP_SESSION_IDLE_MS'] ?? 30 * 60 * 1000);
  const allowedHosts = (process.env['MCP_HTTP_ALLOWED_HOSTS'] ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

  const ctx = await loadContext({});

  interface Session { transport: StreamableHTTPServerTransport; lastSeen: number }
  const sessions = new Map<string, Session>();
  // Sessions still initializing count toward the cap so concurrent initializes cannot overshoot it.
  let pending = 0;

  const closeSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
  };

  const evictLeastRecentlyUsed = (): void => {
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) {
      if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
    }
    if (oldest) {
      log(`session cap reached, evicting ${oldest[0]}`);
      closeSession(oldest[0]);
    }
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) closeSession(id);
  }, Math.max(250, Math.min(idleMs / 2, 60_000)));
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!tokenMatches(req.headers.authorization, token)) {
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
      if (session) session.lastSeen = Date.now();
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
        while (sessions.size + pending >= maxSessions && sessions.size > 0) evictLeastRecentlyUsed();
        if (sessions.size + pending >= maxSessions) {
          sendJson(res, 503, 'Too many sessions initializing');
          return;
        }
        pending++;
        let registered = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            pending--;
            registered = true;
            sessions.set(id, { transport, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        try {
          await createMcpServer(ctx).connect(transport);
          await transport.handleRequest(req, res, body);
        } finally {
          if (!registered) pending--;
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
      if (status === 413) req.destroy();
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
