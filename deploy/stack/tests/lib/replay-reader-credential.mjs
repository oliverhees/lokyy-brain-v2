// LBV2-4 worst-case replay, run inside the metamcp container (stdin, cwd /app/apps/backend):
// assume MetaMCP forwarded every call. Take the bearer token MetaMCP stores for anna's company
// server and call each non-read tool (WRITE_TOOLS, space separated) directly on the company vault.
// Prints one line per tool and a final "rejected N/M accepted K". Never prints the token.
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
const { Client } = require('pg');

const tools = (process.env.WRITE_TOOLS ?? '').split(/\s+/).filter(Boolean);
const marker = process.env.MARKER ?? 'mcpattack-replay';
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query("select url, bearer_token from mcp_servers where name = 'anna-firma'");
await db.end();
if (rows.length !== 1) { console.log('anna-firma server not found'); process.exit(1); }
const { url, bearer_token: token } = rows[0];

const headers = (sid) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
  ...(sid ? { 'mcp-session-id': sid } : {}),
});
const post = async (body, sid) => {
  const res = await fetch(url, { method: 'POST', headers: headers(sid), body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.includes('data: ') ? text.split('\n').filter((l) => l.startsWith('data: ')).pop().slice(6) : text;
  return { res, msg: data ? JSON.parse(data) : null };
};

const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replay', version: '0' } } });
const sid = init.res.headers.get('mcp-session-id');
if (!sid) { console.log(`no session (${init.res.status})`); process.exit(1); }
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

let rejected = 0;
let accepted = 0;
for (const [i, name] of tools.entries()) {
  const args = { slug: marker, title: marker, content: `marker ${marker}`, text: marker, query: marker, url: 'http://127.0.0.1/', path: marker };
  const { msg } = await post({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: args } }, sid);
  const text = msg?.error?.message ?? msg?.result?.content?.[0]?.text ?? '';
  if (/Tool not available/.test(text)) { rejected++; console.log(`rejected ${name}: ${text.slice(0, 60)}`); }
  else { accepted++; console.log(`ACCEPTED ${name}: ${text.slice(0, 60)}`); }
}
console.log(`rejected ${rejected}/${tools.length} accepted ${accepted}`);
