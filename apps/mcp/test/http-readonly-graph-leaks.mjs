/**
 * Read-only re-audit test (LBV2-12, findings N1–N3).
 *  N1 LLM-inferred links (insertLink, origin 'llm') to hidden or nonexistent pages never reveal
 *     the target slug to read-only sessions. Body wikilinks keep the broken-link behaviour.
 *  N2 Community ids (computed over all pages) are never exposed to read-only sessions.
 *  N3 Page-slug arguments are validated centrally for every profile: a `..` path segment,
 *     backslash, NUL or leading slash is rejected with one generic error; legit slugs work.
 * Run from apps/mcp/ directory: node test/http-readonly-graph-leaks.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { createReaderView } from '../dist/index.js';

const FULL = 'full-token-0123456789abcdef-0123456789';
const RO = 'read-token-0123456789abcdef-0123456789';
const PORT = 21000 + Math.floor(Math.random() * 1000);
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;
const HIDDEN_TARGET = 'llmpii-canary';
const MISSING_TARGET = 'llmghost-canary';
const COMMUNITY_ID = 4242;
const UNSAFE_SLUG_ERROR = 'Invalid input: unsafe slug';

const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-graph-'));
const notesDir = join(dataDir, 'wiki', 'notes');
mkdirSync(notesDir, { recursive: true });
const now = new Date().toISOString();
function page(slug, title, body, extra = {}) {
  writeFileSync(join(notesDir, `${slug}.md`), body);
  writeFileSync(join(notesDir, `${slug}.meta.json`), JSON.stringify({
    id: slug, title, type: 'concept', one_liner: `${title} summary`, edit_state: 'ai_generated',
    created: now, updated: now, word_count: 5, sources: [], tags: ['shared'], ...extra,
  }));
}
page('public-page', 'Public Guide', '# Public Guide\n\nSee [[second-public]] and [[body-missing]].\n\n## Notes\n\nStart.');
page('second-public', 'Second Public', '# Second Public\n\nBack to [[public-page]].\n\n## Notes\n\nStart.');
page(HIDDEN_TARGET, 'Hidden Pii', '# Hidden\n\nPii body.', { visibility: 'pii' });

let exitCode = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => { console.error(`FAIL ${msg}`); exitCode = 1; };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));

/**
 * Adds LLM-inferred edges (not present in any page body) and community assignments to the index
 * the server built on startup. Mirrors WikiIndex.insertLink (origin 'llm', confidence 'inferred')
 * and applyCommunityAssignments; @mindbase/core's dist is not importable from plain node, so SQL.
 */
function seedIndex() {
  const db = new Database(join(dataDir, '.index', 'db.sqlite'));
  try {
    const insertLink = db.prepare(`INSERT INTO links (source_slug, target_slug, edge_type, confidence, inference_rule,
      context_snippet, origin, source_project_id, target_project_id, created_at, updated_at)
      VALUES (?, ?, ?, 'inferred', 'llm', NULL, 'llm', 'default', NULL, ?, ?)`);
    insertLink.run('public-page', HIDDEN_TARGET, 'elaborates', now, now);
    insertLink.run('public-page', MISSING_TARGET, 'cites', now, now);
    db.prepare('UPDATE pages SET community_id = ?').run(COMMUNITY_ID);
    db.prepare('DELETE FROM communities').run();
    db.prepare('INSERT INTO communities (id, label, size, computed_at) VALUES (?, ?, ?, ?)').run(COMMUNITY_ID, 'CANARYCOMMUNITY', 3, now);
  } finally {
    db.close();
  }
}

const waitForExit = (proc, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
});
async function waitForPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(URL_MCP, { method: 'POST' }); return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function connect(token) {
  const client = new Client({ name: 'graph-leak-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const toolText = (res) => (res.content ?? []).map((c) => c.text ?? '').join('');
async function call(client, name, args) {
  try { return toolText(await client.callTool({ name, arguments: args })); } catch (e) { return `THROWN ${e.message}`; }
}
async function readRes(client, uri) {
  try { return JSON.stringify(await client.readResource({ uri })); } catch (e) { return `THROWN ${e.message}`; }
}

const GRAPH_CALLS = [
  ['get_graph_insights', {}], ['read_wiki_page', { slug: 'public-page' }],
  ['find_related', { slug: 'default/public-page', depth: 3 }], ['find_related', { slug: 'public-page', depth: 3 }],
  ['export_subgraph', { slug: 'default/public-page', depth: 3 }], ['export_subgraph', { slug: 'public-page', depth: 3 }],
  ['find_orphans', {}], ['suggest_links', { slug: 'public-page' }], ['list_recent', { days: 30, limit: 100 }],
];
const GRAPH_RESOURCES = ['mindbase://insights', 'mindbase://hubs', 'mindbase://orphans', 'mindbase://recent'];

async function graphOutputs(client) {
  const out = [];
  for (const [name, args] of GRAPH_CALLS) out.push([`${name}(${JSON.stringify(args)})`, await call(client, name, args)]);
  for (const uri of GRAPH_RESOURCES) out.push([uri, await readRes(client, uri)]);
  return out;
}

/** N2 at the reader-view boundary: index rows and graph nodes carry community_id, reader copies must not. */
async function readerViewCommunityChecks() {
  const fsp = await import('node:fs/promises');
  const store = {
    readText: (q) => fsp.readFile(join(dataDir, q), 'utf-8'),
    readJSON: async (q) => JSON.parse(await fsp.readFile(join(dataDir, q), 'utf-8')),
    listDir: async (q) => (await fsp.readdir(join(dataDir, q), { withFileTypes: true })).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' })),
  };
  const row = { slug: 'public-page', path: 'wiki/notes/public-page.md', title: 'Public Guide', type: 'concept', kind: null, content_hash: 'h',
    word_count: 1, inbound_count: 0, outbound_count: 0, tags: [], visibility: null, project: null, project_id: 'default', summary: null,
    meta: null, created_at: now, updated_at: now, community_id: COMMUNITY_ID };
  const node = { slug: 'public-page', path: row.path, title: row.title, type: 'concept', tags: [], category: 'concepts', projectId: 'default',
    wordCount: 1, community_id: COMMUNITY_ID };
  const base = { store, searchIndex: { search: () => [] }, cards: { list: async () => [] }, feeds: { summaries: async () => [] },
    getAdapter: () => null, reindex: async () => {}, mcpClient: 'x', allowLocalFilePaths: false,
    wikiIndex: { allPages: () => [row], getPage: () => row,
      buildGraph: () => ({ nodes: new Map([['default/public-page', node]]), edges: [], incoming: new Map(), outgoing: new Map() }) } };
  const view = createReaderView(base);
  await view.refresh();
  const seen = JSON.stringify([view.ctx.wikiIndex.allPages(), view.ctx.wikiIndex.getPage('public-page'), [...view.ctx.wikiIndex.buildGraph().nodes.values()]]);
  check(seen.includes('public-page') && !seen.includes('community'), 'reader view: community_id stripped from rows and graph nodes', seen.slice(0, 300));
  check(row.community_id === COMMUNITY_ID && node.community_id === COMMUNITY_ID, 'reader view: base index objects not mutated');
}

async function run() {
  await readerViewCommunityChecks();
  const proc = spawn('node', ['dist/http.js'], {
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen\n${stderr}`); return; }
    seedIndex();
    const full = await connect(FULL);
    const ro = await connect(RO);

    // N1: full profile still sees the inferred edges (precondition for a meaningful reader check).
    const fullText = (await graphOutputs(full)).map(([, t]) => t).join('\n');
    check(fullText.includes(HIDDEN_TARGET) && fullText.includes(MISSING_TARGET), 'full: inferred edges to hidden and missing pages visible');

    // N1: reader never sees an inferred edge target that is not visible.
    const roOutputs = await graphOutputs(ro);
    const slugLeaks = roOutputs.filter(([, t]) => t.includes(HIDDEN_TARGET) || t.includes(MISSING_TARGET)).map(([k]) => k);
    check(slugLeaks.length === 0, 'readonly: inferred edges to hidden/missing pages dropped everywhere', slugLeaks.join(', '));
    // Body wikilinks keep working: the public page's own body link to a missing page is still a broken link.
    const insights = await call(ro, 'get_graph_insights', {});
    let broken = [];
    try { broken = JSON.parse(insights).broken_links.map((b) => b.target); } catch { broken = []; }
    check(broken.some((t) => t.endsWith('/body-missing')), 'readonly: body wikilink to missing page still reported as broken', JSON.stringify(broken));
    const related = await call(ro, 'find_related', { slug: 'default/public-page', depth: 3 });
    check(related.includes('second-public'), 'readonly: visible body links still returned', related.slice(0, 200));

    // N2: no community data for readers; full profile unchanged.
    const communityLeaks = roOutputs.filter(([, t]) => t.includes('community') || t.includes(String(COMMUNITY_ID)) || t.includes('CANARYCOMMUNITY')).map(([k]) => k);
    check(communityLeaks.length === 0, 'readonly: no community_id or community stats in reader output', communityLeaks.join(', '));

    // N3: central slug validation for every profile.
    const unsafe = ['../x', '../../raw/dump', 'a/../b', '..', 'a\\b', '/etc/passwd', 'x\0y', 'default/../x'];
    const writeCalls = (slug) => [
      ['set_visibility', { slug, level: 'internal' }], ['tag_note', { slug, tags: ['t'] }],
      ['append_to_page', { slug, section: 'Notes', content: 'x' }], ['update_note_section', { slug, section: 'Notes', new_content: 'x' }],
      ['create_card', { question: 'What is it?', answer: 'It is.', source_slug: slug }],
      ['read_wiki_page', { slug }], ['find_related', { slug }], ['export_subgraph', { slug }], ['suggest_links', { slug }],
    ];
    const notRejected = [];
    for (const slug of unsafe) {
      for (const [name, args] of writeCalls(slug)) {
        const text = await call(full, name, args);
        if (!text.includes(UNSAFE_SLUG_ERROR)) notRejected.push(`full ${name}(${JSON.stringify(slug)}) → ${text.slice(0, 80)}`);
      }
      for (const name of ['read_wiki_page', 'find_related', 'export_subgraph', 'suggest_links']) {
        const text = await call(ro, name, { slug });
        if (!text.includes(UNSAFE_SLUG_ERROR)) notRejected.push(`ro ${name}(${JSON.stringify(slug)}) → ${text.slice(0, 80)}`);
      }
    }
    check(notRejected.length === 0, 'all profiles: unsafe slugs rejected centrally with a generic error', notRejected.join(' | '));
    const generic = await call(full, 'set_visibility', { slug: '../secret-name', level: 'pii' });
    check(!generic.includes('secret-name') && !generic.includes(dataDir), 'unsafe slug error echoes neither slug nor path', generic);

    // N3: legit slugs still pass (`..` inside a segment is not a parent segment).
    const visibilitySet = await call(full, 'set_visibility', { slug: 'second-public', level: 'public' });
    check(!visibilitySet.includes(UNSAFE_SLUG_ERROR) && !/error/i.test(visibilitySet), 'full: set_visibility on legit slug works', visibilitySet.slice(0, 200));
    const tagged = await call(full, 'tag_note', { slug: 'second-public', tags: ['extra'] });
    check(!tagged.includes(UNSAFE_SLUG_ERROR) && tagged.includes('extra'), 'full: tag_note on legit slug works', tagged.slice(0, 200));
    const appended = await call(full, 'append_to_page', { slug: 'public-page', section: 'Notes', content: 'Appended line.' });
    check(!appended.includes(UNSAFE_SLUG_ERROR) && !/error/i.test(appended), 'full: append_to_page on legit slug works', appended.slice(0, 200));
    for (const legit of ['x..y', 'a..b/c', 'default/public-page', 'entities/foo']) {
      const text = await call(full, 'read_wiki_page', { slug: legit });
      check(!text.includes(UNSAFE_SLUG_ERROR), `full: slug ${legit} passes slug validation`, text.slice(0, 120));
    }
    check((await call(ro, 'read_wiki_page', { slug: 'public-page' })).includes('Public Guide'), 'readonly: legit read still works');
    check((await readRes(ro, 'mindbase://wiki/x..y')).startsWith('THROWN'), 'readonly: resource with dotted slug behaves like missing page');

    await full.close().catch(() => {});
    await ro.close().catch(() => {});
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    await waitForExit(proc, 5000);
  }
}

run()
  .catch((e) => fail(e.message))
  .finally(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(exitCode); });
