/**
 * LBV2-26 QA blocker 1: the MCP server must use the same project-scoped store as the web server
 * (projects/<currentProjectId>/…), for reads AND writes. Before, it read and wrote <dataDir>/wiki/notes,
 * so notes created via MCP never appeared in the web app and semantic_search never saw indexed pages.
 * Legacy data dirs (wiki/ but no projects/) keep the unscoped layout. Run from apps/mcp/ after `pnpm build`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failures += 1; };
const now = new Date().toISOString();
const page = (dir, slug, title, body) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body);
  writeFileSync(join(dir, `${slug}.meta.json`), JSON.stringify({ id: slug, title, type: 'concept', one_liner: '', edit_state: 'user', created: now, updated: now, word_count: 3 }));
};

function startMcp(dataDir) {
  const proc = spawn('node', ['dist/cli.js', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MINDBASE_EMBED_URL: '', MINDBASE_EMBED_TOKEN: '' } });
  const pending = new Map();
  let buf = '', stderr = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) { try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ } }
  });
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  let id = 0;
  const call = (name, args) => new Promise((resolve, reject) => {
    id += 1;
    const t = setTimeout(() => reject(new Error(`timeout ${name}`)), 15000);
    pending.set(id, (m) => { clearTimeout(t); resolve((m.result?.content ?? []).map((c) => c.text).join('')); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  return { proc, call, stderr: () => stderr };
}

const dirs = [];
try {
  // v2 layout as the web server creates it, plus a stray page in the legacy location
  const d = mkdtempSync(join(tmpdir(), 'mb-mcp-layout-')); dirs.push(d);
  mkdirSync(join(d, 'projects', 'default'), { recursive: true });
  writeFileSync(join(d, 'projects', 'default', 'meta.json'), '{"id":"default"}');
  page(join(d, 'projects', 'default', 'wiki', 'notes'), 'web-note', 'Web Note Zebrafisch', 'Created in the web app about Zebrafisch.');
  page(join(d, 'wiki', 'notes'), 'stray-legacy', 'Stray Legacy', 'Old MCP write.');
  const m = startMcp(d);
  await new Promise((r) => setTimeout(r, 600));
  const s1 = await m.call('search_wiki', { query: 'Zebrafisch' });
  check('search_wiki finds a page of the current project (projects/default)', s1.includes('web-note'), s1.slice(0, 200));
  const r1 = await m.call('read_wiki_page', { slug: 'web-note' });
  check('read_wiki_page reads the project page', r1.includes('Zebrafisch'), r1.slice(0, 200));
  const c1 = await m.call('create_note', { title: 'MCP Note Okapi', content: 'Okapi from MCP' });
  check('create_note writes into projects/default/wiki/notes', existsSync(join(d, 'projects', 'default', 'wiki', 'notes', 'mcp-note-okapi.md')), c1);
  check('create_note does not write the legacy wiki/notes', !existsSync(join(d, 'wiki', 'notes', 'mcp-note-okapi.md')), c1);
  check('stray pages in the legacy location are reported at startup', /legacy/i.test(m.stderr()) && m.stderr().includes('1'), m.stderr().slice(0, 300));
  m.proc.kill();

  // currentProjectId from config.json
  const d2 = mkdtempSync(join(tmpdir(), 'mb-mcp-layout-')); dirs.push(d2);
  writeFileSync(join(d2, 'config.json'), '{"currentProjectId":"research"}');
  page(join(d2, 'projects', 'research', 'wiki', 'notes'), 'alt-page', 'Alt Page Quokka', 'Quokka');
  page(join(d2, 'projects', 'default', 'wiki', 'notes'), 'default-page', 'Default Page Quokka', 'Quokka');
  const m2 = startMcp(d2);
  await new Promise((r) => setTimeout(r, 600));
  const s2 = await m2.call('search_wiki', { query: 'Quokka' });
  check('config.json currentProjectId selects the project', s2.includes('alt-page') && !s2.includes('default-page'), s2.slice(0, 200));
  m2.proc.kill();

  // Legacy data dir (no projects/): unchanged behaviour
  const d3 = mkdtempSync(join(tmpdir(), 'mb-mcp-layout-')); dirs.push(d3);
  page(join(d3, 'wiki', 'notes'), 'legacy-page', 'Legacy Page Tapir', 'Tapir');
  const m3 = startMcp(d3);
  await new Promise((r) => setTimeout(r, 600));
  const s3 = await m3.call('search_wiki', { query: 'Tapir' });
  check('legacy layout (no projects/) still works', s3.includes('legacy-page'), s3.slice(0, 200));
  m3.proc.kill();
} catch (e) {
  check('run', false, e.message);
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(failures === 0 ? '\n✓ project layout checks passed' : `\n✗ ${failures} project layout checks failed`);
process.exit(failures === 0 ? 0 : 1);
