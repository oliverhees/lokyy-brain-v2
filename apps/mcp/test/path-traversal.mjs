/**
 * Path traversal regression test (LBV2-11).
 * A canary secret lives in mindbase.config.json at the vault root and in a file next to
 * the vault. No slug or projectId passed by an MCP client may read either.
 * Run from apps/mcp/ directory: node test/path-traversal.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'full-token-0123456789abcdef-0123456789';
const CANARY = 'CANARY-7f3a9c-DO-NOT-LEAK';
const PORT = 20000 + Math.floor(Math.random() * 1000);

const outer = mkdtempSync(join(tmpdir(), 'mb-trav-'));
const dataDir = join(outer, 'vault');
mkdirSync(join(dataDir, 'wiki', 'notes'), { recursive: true });
mkdirSync(join(dataDir, 'projects', 'demo'), { recursive: true });
writeFileSync(join(dataDir, 'mindbase.config.json'), JSON.stringify({ provider: 'openai', model: 'x', apiKey: CANARY, baseUrl: '' }));
writeFileSync(join(outer, 'outside.md'), `# Outside\n${CANARY}`);
writeFileSync(join(outer, 'outside.meta.json'), JSON.stringify({ id: 'outside', title: CANARY }));
mkdirSync(join(outer, 'evil', 'x'), { recursive: true });
writeFileSync(join(outer, 'evil', 'README.md'), CANARY);

let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

const proc = spawn('node', ['dist/http.js'], {
  env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
proc.stderr.on('data', (c) => { stderr += c.toString(); });

async function waitForPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' }); return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function leaks(fn) {
  try {
    const res = await fn();
    return JSON.stringify(res).includes(CANARY);
  } catch (e) {
    return String(e?.message ?? e).includes(CANARY);
  }
}

async function run() {
  if (!(await waitForPort(20000))) { fail(`server did not start\n${stderr}`); return; }
  const client = new Client({ name: 'trav', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  }));

  const slugs = ['../../mindbase.config', '../../../outside', '..%2F..%2Fmindbase.config', '/etc/passwd', 'x/../../../outside'];
  for (const slug of slugs) {
    (await leaks(() => client.callTool({ name: 'read_wiki_page', arguments: { slug } })))
      ? fail(`read_wiki_page slug=${slug} leaked the canary`) : ok(`read_wiki_page slug=${slug} does not leak`);
    (await leaks(() => client.readResource({ uri: `mindbase://wiki/${slug}` })))
      ? fail(`resource wiki/${slug} leaked the canary`) : ok(`resource wiki/${slug} does not leak`);
    (await leaks(() => client.callTool({ name: 'export_subgraph', arguments: { slug, root: slug, depth: 1 } })))
      ? fail(`export_subgraph ${slug} leaked`) : ok(`export_subgraph ${slug} does not leak`);
  }

  for (const projectId of ['../../evil', '../..', '/tmp', 'demo/../../../evil', '..']) {
    for (const name of ['mindbase_status', 'mindbase_gather_sources', 'mindbase_validate_structure', 'mindbase_load_project']) {
      const res = await client.callTool({ name, arguments: { projectId, persist: false } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
      const text = JSON.stringify(res);
      if (text.includes(CANARY) || text.includes(outer)) fail(`${name} projectId=${projectId} leaked path or content`);
      else if (!res.isError) fail(`${name} projectId=${projectId} was accepted`);
      else ok(`${name} projectId=${projectId} rejected`);
    }
  }

  const valid = await client.callTool({ name: 'mindbase_status', arguments: { projectId: 'demo' } });
  !valid.isError ? ok('valid projectId still works') : fail(`valid projectId rejected: ${JSON.stringify(valid).slice(0, 200)}`);

  await client.close().catch(() => {});
}

run()
  .catch((e) => fail(`${e.message}\n${stderr}`))
  .finally(() => { proc.kill('SIGTERM'); rmSync(outer, { recursive: true, force: true }); process.exit(exitCode); });
