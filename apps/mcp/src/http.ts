#!/usr/bin/env node
// apps/mcp/src/http.ts
// Serves the MindBase MCP server over Streamable HTTP for self-hosted deployments,
// so an aggregator (e.g. MetaMCP) can reach a vault over an internal network
// without mounting the vault's data directory itself.
//
// Env:
//   MCP_HTTP_TOKEN  required, >= 16 chars; clients send `Authorization: Bearer <token>`
//   MCP_HTTP_PORT   default 4322
//   MCP_HTTP_HOST   default 0.0.0.0
//   MCP_HTTP_MAX_SESSIONS  default 32
import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadContext } from './context.js';
import { createMcpServer } from './index.js';

const MIN_TOKEN_LENGTH = 16;
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

function sendJson(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
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
  const maxSessions = Number(process.env['MCP_HTTP_MAX_SESSIONS'] ?? 32);

  const ctx = await loadContext({});
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!tokenMatches(req.headers.authorization, token)) {
        sendJson(res, 401, 'Unauthorized');
        return;
      }
      if (url.pathname !== '/mcp') {
        sendJson(res, 404, 'Not found');
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }
        if (sessionId !== undefined || !isInitializeRequest(body)) {
          sendJson(res, 400, 'Bad Request: no valid session');
          return;
        }
        if (sessions.size >= maxSessions) {
          sendJson(res, 503, 'Too many sessions');
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, transport); },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createMcpServer(ctx).connect(transport);
        await transport.handleRequest(req, res, body);
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
      log(`request error: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 400, 'Bad Request');
    }
  });

  server.listen(port, host, () => {
    log(`listening on http://${host}:${port}/mcp · dataDir=${ctx.dataDir}`);
  });

  const shutdown = () => {
    for (const t of sessions.values()) void t.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
