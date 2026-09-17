// vault-connector: one-way path MetaMCP → vaults.
// MetaMCP and the vaults no longer share a network. The connector sits on `mcp-upstream` (with
// MetaMCP) and on every `mcp-<vault>` network, but listens only on its mcp-upstream address, so a
// vault can open no connection to it and none to MetaMCP. Requests are routed by Host header
// `mcp.vault-<vault>:4322` (the name MetaMCP uses) to that vault; the Host header is kept for the
// vault's MCP_HTTP_ALLOWED_HOSTS check. Streams are piped, never buffered.
import http from 'node:http';

export interface ConnectorOptions {
  vaults: string[];
  target: (vault: string) => { host: string; port: number };
  log: (line: string) => void;
}

const HOST_RE = /^mcp\.vault-([a-z0-9][a-z0-9-]{0,30}):4322$/;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'];

export function createConnector(opts: ConnectorOptions): http.Server {
  const allowed = new Set(opts.vaults);
  const server = http.createServer((req, res) => {
    const vault = HOST_RE.exec(req.headers.host ?? '')?.[1];
    if (!vault || !allowed.has(vault)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
      req.resume();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.includes(k) && v !== undefined) headers[k] = v;
    const { host, port } = opts.target(vault);
    const up = http.request({ host, port, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      res.flushHeaders();
      upRes.pipe(res);
    });
    up.on('error', () => {
      opts.log(`upstream error vault=${vault}`);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"bad_gateway"}'); } else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.requestTimeout = 0;
  return server;
}
