/**
 * Read-only hardening test (LBV2-12).
 *  1. Pages with visibility "internal" or "pii" (or unreadable meta) are invisible to
 *     read-only sessions in every allowlisted tool and every resource; full sessions
 *     are unchanged. Reading a hidden page fails exactly like reading a missing page.
 *  2. Per-profile session caps: read-only sessions never evict full sessions and vice versa.
 *  3. The allowlist is immutable at runtime.
 *  4. Read-only sessions get reader instructions and only prompts they can follow.
 * Run from apps/mcp/ directory: node test/http-readonly-visibility.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as mcpIndex from '../dist/index.js';

const FULL = 'full-token-0123456789abcdef-0123456789';
const RO = 'read-token-0123456789abcdef-0123456789';
const PORT = 20000 + Math.floor(Math.random() * 1000);
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;

const CANARIES = ['CANARYINT', 'CANARYPII', 'CANARYMETA', 'canarytag'];
const HIDDEN = ['internal-page', 'pii-page', 'broken-meta-page'];

const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-vis-'));
const notesDir = join(dataDir, 'wiki', 'notes');
mkdirSync(notesDir, { recursive: true });
const now = new Date().toISOString();
function page(slug, title, body, extra = {}) {
  writeFileSync(join(notesDir, `${slug}.md`), body);
  writeFileSync(join(notesDir, `${slug}.meta.json`), JSON.stringify({
    id: slug, title, type: 'concept', one_liner: `${title} summary`, edit_state: 'ai_generated',
    created: now, updated: now, word_count: 5, project: 'p1', sources: ['shared-source'], tags: ['shared'], ...extra,
  }));
}
page('public-page', 'Public Guide', '# Public Guide\n\nA shared guide. See [[internal-page]] and [[pii-page]] and [[broken-meta-page]].');
page('second-public', 'Second Public', '# Second Public\n\nAnother shared guide linking [[public-page]].', { tags: ['shared', 'other'] });
page('internal-page', 'Internal CANARYINT Title', '# Internal\n\nCANARYINT body shared guide [[public-page]] [[pii-page]].',
  { visibility: 'internal', tags: ['shared', 'canarytag-internal'], one_liner: 'CANARYINT one liner' });
page('pii-page', 'Pii CANARYPII Title', '# Pii\n\nCANARYPII body shared guide [[public-page]].',
  { visibility: 'pii', tags: ['shared', 'canarytag-pii'], one_liner: 'CANARYPII one liner' });
writeFileSync(join(notesDir, 'broken-meta-page.md'), '# Broken meta\n\nCANARYMETA body shared guide [[public-page]].');
writeFileSync(join(notesDir, 'broken-meta-page.meta.json'), '{ not json CANARYMETA');
writeFileSync(join(dataDir, 'wiki', '_insights.md'), '# Wiki Insights\n\n- [[internal-page]] Internal CANARYINT Title\n');
mkdirSync(join(dataDir, 'srs'), { recursive: true });
const card = (id, slug, q) => ({ id, question: q, answer: q, source_slug: slug, tags: [], created_at: now, created_via: 'auto',
  interval: 1, ease_factor: 2.5, repetitions: 0, due_at: '2000-01-01T00:00:00.000Z', review_history: [], archived: false });
writeFileSync(join(dataDir, 'srs', 'cards.json'), JSON.stringify({ cards: [
  card('c1', 'public-page', 'Public question'), card('c2', 'internal-page', 'CANARYINT question'), card('c3', 'pii-page', 'CANARYPII question'),
] }));

let exitCode = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => { console.error(`FAIL ${msg}`); exitCode = 1; };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));

function startServer(env) {
  return spawn('node', ['dist/http.js'], {
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const client = new Client({ name: 'vis-test', version: '0.0.0' });
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
const leaks = (text) => CANARIES.filter((c) => text.includes(c));

/** Every allowlisted tool call a reader can make against the fixture. */
const TOOL_CALLS = [
  ['search_wiki', { query: 'CANARYINT' }], ['search_wiki', { query: 'CANARYPII' }], ['search_wiki', { query: 'CANARYMETA' }],
  ['search_wiki', { query: 'shared guide', limit: 50 }],
  ['search_all_projects', { query: 'CANARYINT' }], ['search_all_projects', { query: 'page', limit: 50 }],
  ['search_in_project', { query: 'shared guide', project: 'p1', limit: 50 }], ['search_in_project', { query: 'CANARYPII', project: 'p1' }],
  ['read_wiki_page', { slug: 'public-page' }], ['read_wiki_page', { slug: 'internal-page' }],
  ['read_wiki_page', { slug: 'pii-page' }], ['read_wiki_page', { slug: 'broken-meta-page' }], ['read_wiki_page', { slug: 'page' }],
  ['list_recent', { days: 30, limit: 100 }],
  ['find_related', { slug: 'public-page', depth: 3 }], ['find_related', { slug: 'default/public-page', depth: 3 }],
  ['find_related', { slug: 'internal-page' }], ['find_related', { slug: 'default/internal-page' }],
  ['get_graph_insights', {}], ['find_orphans', {}],
  ['suggest_links', { slug: 'public-page' }], ['suggest_links', { slug: 'internal-page' }], ['suggest_links', { slug: 'default/pii-page' }],
  ['export_subgraph', { slug: 'public-page', depth: 3 }], ['export_subgraph', { slug: 'default/public-page', depth: 3 }],
  ['export_subgraph', { slug: 'default/internal-page' }],
  ['list_feeds', {}], ['list_review_cards', {}], ['list_review_cards', { due_only: false, limit: 100 }],
  ['mindbase_status', {}], ['mindbase_gather_sources', {}], ['mindbase_validate_structure', {}],
];
const RESOURCE_URIS = ['mindbase://recent', 'mindbase://hubs', 'mindbase://orphans', 'mindbase://insights',
  'mindbase://wiki/public-page', 'mindbase://wiki/internal-page', 'mindbase://wiki/pii-page', 'mindbase://wiki/broken-meta-page'];

async function visibilityChecks() {
  const proc = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen\n${stderr}`); return; }
    const full = await connect(FULL);
    const ro = await connect(RO);
    const fullTools = (await full.listTools()).tools.map((t) => t.name);
    const roTools = (await ro.listTools()).tools.map((t) => t.name);

    // Coverage guard: every allowlisted tool is exercised below.
    const untested = roTools.filter((n) => !TOOL_CALLS.some(([t]) => t === n));
    check(untested.length === 0, 'every read-only tool is covered by the canary sweep', untested.join(', '));

    // Full profile still sees hidden pages (unchanged behaviour).
    check((await call(full, 'search_wiki', { query: 'CANARYINT' })).includes('internal-page'), 'full: search_wiki finds internal page');
    check((await call(full, 'read_wiki_page', { slug: 'pii-page' })).includes('CANARYPII'), 'full: read_wiki_page reads pii page');
    const fullResList = JSON.stringify((await full.listResources()).resources);
    check(fullResList.includes('mindbase://wiki/internal-page') && fullResList.includes('CANARYPII'), 'full: resources list hidden pages');
    check((await call(full, 'list_review_cards', { due_only: false })).includes('CANARYINT'), 'full: review cards include internal-derived card');

    // Read-only: no canary in any tool response.
    const toolLeaks = [];
    for (const [name, args] of TOOL_CALLS) {
      const text = await call(ro, name, args);
      const found = leaks(text);
      if (found.length > 0) toolLeaks.push(`${name}(${JSON.stringify(args)}) → ${found.join(',')}`);
      // A reader-view member a tool needs but the view does not provide would surface as this error.
      if (text.includes('not available to read-only sessions')) toolLeaks.push(`${name} hit an unsupported reader-view member: ${text.slice(0, 160)}`);
    }
    check(toolLeaks.length === 0, 'readonly: no canary in any allowlisted tool response', toolLeaks.join(' | '));

    // Read-only: public data still works.
    const pub = await call(ro, 'read_wiki_page', { slug: 'public-page' });
    check(pub.includes('Public Guide'), 'readonly: public page readable');
    let pubJson = {};
    try { pubJson = JSON.parse(pub); } catch { /* checked below */ }
    const linkLists = JSON.stringify([pubJson.incoming ?? null, pubJson.outgoing ?? null]);
    check(!HIDDEN.some((s) => linkLists.includes(s)), 'readonly: public page link lists omit hidden pages', linkLists);
    check((await call(ro, 'search_wiki', { query: 'shared guide', limit: 50 })).includes('public-page'), 'readonly: search still finds public page');

    // Structured slug lists never mention hidden slugs. Snippets/bodies of PUBLIC pages may
    // legitimately contain the text "[[internal-page]]" — that is public content, so they are stripped.
    const structuredOnly = (text) => {
      try { return JSON.stringify(JSON.parse(text, (k, v) => (k === 'snippet' || k === 'body' ? undefined : v))); } catch { return text; }
    };
    const structured = [
      await call(ro, 'search_wiki', { query: 'shared guide', limit: 50 }),
      await call(ro, 'search_all_projects', { query: 'page', limit: 50 }),
      await call(ro, 'search_in_project', { query: 'shared guide', project: 'p1', limit: 50 }),
      await call(ro, 'list_recent', { days: 30, limit: 100 }),
      await call(ro, 'find_orphans', {}),
      await call(ro, 'find_related', { slug: 'default/public-page', depth: 3 }),
      await call(ro, 'suggest_links', { slug: 'public-page' }),
      await call(ro, 'list_review_cards', { due_only: false, limit: 100 }),
    ].map(structuredOnly).join('\n');
    const slugLeaks = HIDDEN.filter((s) => structured.includes(s));
    check(slugLeaks.length === 0, 'readonly: search/list/graph results omit hidden slugs', slugLeaks.join(', '));
    const insights = await call(ro, 'get_graph_insights', {});
    check(!HIDDEN.some((s) => insights.includes(s)), 'readonly: graph insights (incl. broken links) omit hidden slugs', insights.slice(0, 300));
    const subgraph = await call(ro, 'export_subgraph', { slug: 'default/public-page', depth: 3 });
    let pagesIncluded = '';
    try { pagesIncluded = JSON.stringify(JSON.parse(subgraph).pages_included); } catch { pagesIncluded = subgraph; }
    check(!HIDDEN.some((s) => pagesIncluded.includes(s)), 'readonly: export_subgraph pages_included omits hidden pages', pagesIncluded);

    // No existence oracle: hidden read == nonexistent read (slug normalized).
    const norm = (text, slug) => text.split(slug).join('<slug>');
    for (const [tool, hiddenSlug, missingSlug] of [
      ['read_wiki_page', 'internal-page', 'nothere-page'], ['read_wiki_page', 'pii-page', 'nothere-page'],
      ['read_wiki_page', 'broken-meta-page', 'nothere-page'],
      ['find_related', 'default/internal-page', 'default/nothere-page'],
      ['export_subgraph', 'default/pii-page', 'default/nothere-page'],
      ['suggest_links', 'internal-page', 'nothere-page'],
    ]) {
      const h = norm(await call(ro, tool, { slug: hiddenSlug }), hiddenSlug);
      const m = norm(await call(ro, tool, { slug: missingSlug }), missingSlug);
      check(h === m, `readonly: ${tool}(${hiddenSlug}) indistinguishable from missing page`, `${h.slice(0, 160)} vs ${m.slice(0, 160)}`);
    }
    const hiddenRes = norm(await readRes(ro, 'mindbase://wiki/internal-page'), 'internal-page');
    const missingRes = norm(await readRes(ro, 'mindbase://wiki/nothere-page'), 'nothere-page');
    check(hiddenRes.startsWith('THROWN') && hiddenRes === missingRes, 'readonly: hidden wiki resource read indistinguishable from missing', `${hiddenRes} vs ${missingRes}`);
    check(!hiddenRes.includes(dataDir), 'readonly: resource error has no absolute path');

    // Resources.
    const roResList = JSON.stringify((await ro.listResources()).resources);
    check(leaks(roResList).length === 0 && !HIDDEN.some((s) => roResList.includes(`wiki/${s}`)), 'readonly: resources list hides hidden pages', roResList.slice(0, 300));
    check(roResList.includes('mindbase://wiki/public-page'), 'readonly: resources list keeps public page');
    const resLeaks = [];
    for (const uri of RESOURCE_URIS) {
      const text = await readRes(ro, uri);
      if (leaks(text).length > 0) resLeaks.push(`${uri} → ${leaks(text).join(',')}`);
      if (['mindbase://recent', 'mindbase://hubs', 'mindbase://orphans', 'mindbase://insights'].includes(uri) && HIDDEN.some((s) => text.includes(s))) {
        resLeaks.push(`${uri} → hidden slug`);
      }
    }
    check(resLeaks.length === 0, 'readonly: no canary or hidden slug in any resource read', resLeaks.join(' | '));
    check((await readRes(ro, 'mindbase://wiki/public-page')).includes('Public Guide'), 'readonly: public wiki resource readable');

    // 4. Reader instructions + prompts.
    const writeTools = fullTools.filter((n) => !roTools.includes(n));
    const mentionsWriteTool = (text) => writeTools.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    const roInstr = ro.getInstructions() ?? '';
    const fullInstr = full.getInstructions() ?? '';
    check(roInstr.length > 0 && mentionsWriteTool(roInstr).length === 0, 'readonly: instructions mention no write/hidden tools', mentionsWriteTool(roInstr).join(', '));
    check(fullInstr.includes('save_chat_excerpt'), 'full: instructions unchanged (mention save_chat_excerpt)');
    const roPrompts = (await ro.listPrompts()).prompts.map((p) => p.name);
    const fullPrompts = (await full.listPrompts()).prompts.map((p) => p.name);
    check(fullPrompts.includes('audit'), 'full: audit prompt listed');
    check(!roPrompts.includes('audit'), 'readonly: audit prompt (run_wiki_health) hidden');
    const badPrompts = [];
    for (const name of roPrompts) {
      const res = await ro.getPrompt({ name, arguments: { topic: 't', slug: 'public-page' } });
      const found = mentionsWriteTool(JSON.stringify(res));
      if (found.length > 0) badPrompts.push(`${name} → ${found.join(',')}`);
    }
    check(badPrompts.length === 0, 'readonly: every listed prompt references only allowlisted tools', badPrompts.join(' | '));
    let auditGet = false;
    try { await ro.getPrompt({ name: 'audit' }); auditGet = true; } catch { /* rejected */ }
    check(!auditGet, 'readonly: getPrompt(audit) rejected');

    await full.close().catch(() => {});
    await ro.close().catch(() => {});
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    await waitForExit(proc, 5000);
  }
}

async function sessionCapChecks() {
  const bad = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO, MCP_HTTP_MAX_READONLY_SESSIONS: '0' });
  const badCode = await waitForExit(bad, 5000);
  if (badCode === null || badCode === 0) { bad.kill(); fail('server started with MCP_HTTP_MAX_READONLY_SESSIONS=0'); }
  else ok('server refuses invalid MCP_HTTP_MAX_READONLY_SESSIONS');

  const proc = startServer({ MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO, MCP_HTTP_MAX_SESSIONS: '1', MCP_HTTP_MAX_READONLY_SESSIONS: '2' });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`cap server did not listen\n${stderr}`); return; }
    const headers = (t, sid) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${t}`, ...(sid ? { 'mcp-session-id': sid } : {}) });
    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cap', version: '0' } } });
    const open = async (t) => { const r = await fetch(URL_MCP, { method: 'POST', headers: headers(t), body: initBody }); await r.text(); return r.headers.get('mcp-session-id'); };
    const alive = async (t, sid) => {
      const r = await fetch(URL_MCP, { method: 'POST', headers: headers(t, sid), body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
      await r.text();
      return r.status === 200;
    };
    const full1 = await open(FULL);
    const ro1 = await open(RO);
    const ro2 = await open(RO);
    const ro3 = await open(RO); // evicts ro1, never full1
    check(Boolean(full1 && ro3), 'cap: sessions opened');
    check(await alive(FULL, full1), 'cap: read-only sessions beyond MCP_HTTP_MAX_SESSIONS do not evict the full session');
    check(!(await alive(RO, ro1)) && (await alive(RO, ro2)) && (await alive(RO, ro3)), 'cap: read-only cap evicts only the oldest read-only session');
    const full2 = await open(FULL); // evicts full1, never a read-only session
    check(!(await alive(FULL, full1)) && (await alive(FULL, full2)), 'cap: full cap evicts the oldest full session');
    check((await alive(RO, ro2)) && (await alive(RO, ro3)), 'cap: full sessions do not evict read-only sessions');
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    await waitForExit(proc, 5000);
  }
}

async function allowlistChecks() {
  check(!('READ_ONLY_TOOLS' in mcpIndex), 'allowlist: mutable READ_ONLY_TOOLS Set is no longer exported');
  const names = mcpIndex.READ_ONLY_TOOL_NAMES;
  check(Array.isArray(names) && names.length === 15 && Object.isFrozen(names), 'allowlist: READ_ONLY_TOOL_NAMES is a frozen array of 15');
  try { names.push('create_note'); } catch { /* frozen */ }
  const allowed = mcpIndex.isToolAllowed;
  check(typeof allowed === 'function' && allowed('readonly', 'create_note') === false && allowed('readonly', 'search_wiki') === true
    && allowed('full', 'create_note') === true, 'allowlist: isToolAllowed exported and unaffected by mutation attempts');
}

async function run() {
  await allowlistChecks();
  await visibilityChecks();
  await sessionCapChecks();
}

run()
  .catch((e) => fail(e.message))
  .finally(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(exitCode); });
