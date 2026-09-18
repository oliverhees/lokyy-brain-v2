// Minimal scripted browser for the E2E stack: talks to Traefik (TRAEFIK_URL) with the public Host
// header, keeps cookies per host, follows redirects and completes Authentik flows through the flow
// executor API (the same API the Authentik web UI uses).
import http from 'node:http';

const TRAEFIK = new URL(process.env['TRAEFIK_URL'] ?? 'http://traefik:80');

export interface Res {
  status: number;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

export interface Credentials {
  username: string;
  password: string;
  /** New password for set-password (recovery) flows */
  newPassword?: string;
}

export class Browser {
  #jar = new Map<string, Map<string, string>>();

  cookies(host: string): Map<string, string> {
    let m = this.#jar.get(host);
    if (!m) { m = new Map(); this.#jar.set(host, m); }
    return m;
  }

  request(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
    const u = new URL(url);
    const jar = this.cookies(u.hostname);
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      host: u.host,
      accept: 'text/html,application/json',
      ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
      ...opts.headers,
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: TRAEFIK.hostname, port: TRAEFIK.port || 80, method: opts.method ?? 'GET', path: `${u.pathname}${u.search}`, headers }, (res) => {
        for (const c of res.headers['set-cookie'] ?? []) {
          const [pair] = c.split(';');
          const i = pair!.indexOf('=');
          const name = pair!.slice(0, i).trim();
          const value = pair!.slice(i + 1).trim();
          if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') jar.delete(name); else jar.set(name, value);
        }
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, url, headers: res.headers, body: text, json: <T>() => JSON.parse(text) as T });
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`timeout ${url}`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** GET url, follow redirects; Authentik flow pages are completed with creds. Returns the final response. */
  async visit(url: string, creds?: Credentials): Promise<Res> {
    let current = url;
    for (let hop = 0; hop < 25; hop++) {
      const u = new URL(current);
      const flow = /^\/if\/flow\/([^/]+)\/$/.exec(u.pathname);
      if (flow) {
        if (!creds) throw new Error(`login required at ${current}`);
        current = new URL(await this.runFlow(u, flow[1]!, creds), u).toString();
        continue;
      }
      const res = await this.request(current);
      if (process.env['E2E_DEBUG']) console.log(`[visit] ${res.status} ${current} -> ${res.headers.location ?? ''}`);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects from ${url}`);
  }

  /** Runs an Authentik flow via /api/v3/flows/executor; returns the URL the flow redirects to. */
  async runFlow(page: URL, slug: string, creds: Credentials): Promise<string> {
    const api = new URL(`/api/v3/flows/executor/${slug}/`, page);
    api.searchParams.set('query', page.search.replace(/^\?/, ''));
    const send = async (body?: unknown) => {
      const csrf = this.cookies(page.hostname).get('authentik_csrf');
      let res = await this.request(api.toString(), { method: body ? 'POST' : 'GET', body, headers: csrf ? { 'x-authentik-csrf': csrf } : {} });
      for (let i = 0; i < 5 && res.status === 302 && res.headers.location; i++) {
        const next = new URL(res.headers.location, api);
        if (!next.pathname.startsWith('/api/v3/flows/executor/')) return { component: 'xak-flow-redirect', to: next.toString() };
        res = await this.request(next.toString());
      }
      if (process.env['E2E_DEBUG']) console.log(`[flow] ${body ? 'POST' : 'GET'} ${res.status} loc=${res.headers.location ?? ''} len=${res.body.length} ${res.body.slice(0, 120)}`);
      if (res.status >= 400) throw new Error(`flow ${slug}: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      return res.json<Record<string, unknown>>();
    };
    let ch = await send();
    for (let step = 0; step < 12; step++) {
      switch (ch['component']) {
        case 'ak-stage-identification':
          ch = await send({ component: ch['component'], uid_field: creds.username, ...(ch['password_fields'] ? { password: creds.password } : {}) });
          break;
        case 'ak-stage-password':
          ch = await send({ component: ch['component'], password: creds.password });
          break;
        case 'ak-stage-prompt': {
          const pw = creds.newPassword ?? creds.password;
          ch = await send({ component: ch['component'], password: pw, password_repeat: pw });
          break;
        }
        case 'ak-stage-consent':
          ch = await send({ component: ch['component'], token: ch['token'] });
          break;
        case 'xak-flow-redirect':
          return String(ch['to']);
        default:
          throw new Error(`flow ${slug}: unexpected challenge ${JSON.stringify(ch).slice(0, 500)}`);
      }
      if (Array.isArray(ch['response_errors']) || (ch['response_errors'] && Object.keys(ch['response_errors'] as object).length)) {
        throw new Error(`flow ${slug}: ${JSON.stringify(ch['response_errors'])}`);
      }
    }
    throw new Error(`flow ${slug}: did not finish`);
  }
}

/** MCP over the public endpoint (mcp-gate): initialize + tools/list; returns tool names or the HTTP status. */
export async function mcpTools(b: Browser, url: string, apiKey: string): Promise<string[] | number> {
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json, text/event-stream' };
  const parse = (r: Res) => {
    const line = r.body.split('\n').filter((l) => l.startsWith('data: ')).pop();
    return JSON.parse(line ? line.slice(6) : r.body) as { result?: { tools?: { name: string }[] } };
  };
  const init = await b.request(url, { method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } } });
  if (init.status !== 200) return init.status;
  const sid = String(init.headers['mcp-session-id']);
  await b.request(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  const list = await b.request(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  if (list.status !== 200) return list.status;
  await b.request(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } });
  return (parse(list).result?.tools ?? []).map((t) => t.name);
}
