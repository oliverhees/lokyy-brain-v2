/**
 * Reader ask_wiki test (LBV2-18).
 *  1. ask_wiki is allowlisted for read-only sessions (13 tools).
 *  2. In reader sessions only visible root-wiki pages ever reach the LLM prompt, even when
 *     context_pages names hidden pages; the response echoes no hidden content or slug.
 *  3. ask_wiki persists nothing (data dir unchanged).
 *  4. Reader provider requests are rate limited per session and per token; an exceeded limit is
 *     a tool error without an LLM call. Calls without a provider request (invalid input, no
 *     visible page) consume no budget. Full sessions are not limited.
 *  5. Invalid rate-limit env values stop the server at startup.
 *  6. context_pages and ingest_plan.raw_id go through the central slug check.
 *  7. Bounds: question <= 2000 chars, <= 20 context_pages, context block truncated deterministically.
 *  8. Concept-layer pages are used as context; unexpected failures return a generic error.
 *
 * The LLM is a local mock of the Ollama chat API (provider "ollama", baseUrl on 127.0.0.1)
 * that records every request body. No test-only code path exists in the server.
 * Run from apps/mcp/ directory: node test/http-readonly-ask-wiki.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { READ_ONLY_TOOL_NAMES } from '../dist/index.js';

const FULL = 'full-token-0123456789abcdef-0123456789';
const RO = 'read-token-0123456789abcdef-0123456789';
const PORT = 21000 + Math.floor(Math.random() * 1000);
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;
const UNSAFE_SLUG_ERROR = 'Invalid input: unsafe slug';

const CANARIES = ['CANARYHCON', 'CANARYINT', 'CANARYPII', 'CANARYMETA', 'CANARYPROJ', 'CANARYCONCEPT', 'CANARYRAW', 'CANARYCHAT', 'CANARYFLIP'];
const HIDDEN_SLUGS = ['hidden-concept', 'internal-page', 'pii-page', 'broken-meta-page', 'flip-page', 'proj-only'];

// --- mock LLM (Ollama /api/chat, NDJSON stream) ---------------------------------------
const llmRequests = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    llmRequests.push(body);
    if (body.includes('FAILME')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('PROVIDERDETAIL upstream 10.0.0.5 exploded');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Mock answer [1].' } })}\n`);
    res.end(`${JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_URL = `http://127.0.0.1:${mock.address().port}`;

// --- fixture vault ----------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'mb-mcp-ask-'));
const notesDir = join(dataDir, 'wiki', 'notes');
mkdirSync(notesDir, { recursive: true });
const now = new Date().toISOString();
const meta = (id, title, extra = {}) => JSON.stringify({ id, title, type: 'concept', one_liner: `${title} summary`,
  edit_state: 'ai_generated', created: now, updated: now, word_count: 5, sources: [], tags: [], ...extra });
function page(slug, title, body, extra = {}) {
  writeFileSync(join(notesDir, `${slug}.md`), body);
  writeFileSync(join(notesDir, `${slug}.meta.json`), meta(slug, title, extra));
}
page('public-page', 'Public Guide', '# Public Guide\n\nPUBLICMARKER shared guide. See [[internal-page]] and [[pii-page]] and [[second-public]].');
page('second-public', 'Second Public', '# Second\n\nSECONDMARKER shared guide [[public-page]].');
page('internal-page', 'Internal CANARYINT', '# Internal\n\nCANARYINT shared guide [[public-page]] [[pii-page]].',
  { visibility: 'internal', one_liner: 'CANARYINT one liner' });
page('pii-page', 'Pii CANARYPII', '# Pii\n\nCANARYPII shared guide [[public-page]].', { visibility: 'pii', one_liner: 'CANARYPII' });
page('flip-page', 'Flip', '# Flip\n\nCANARYFLIP shared guide [[public-page]].');
writeFileSync(join(notesDir, 'broken-meta-page.md'), '# Broken\n\nCANARYMETA shared guide [[public-page]].');
writeFileSync(join(notesDir, 'broken-meta-page.meta.json'), '{ nope CANARYMETA');
mkdirSync(join(dataDir, 'wiki', 'concepts'), { recursive: true });
writeFileSync(join(dataDir, 'wiki', 'concepts', 'concept-public.md'), '# Concept public\n\nCONCEPTMARKER shared guide');
writeFileSync(join(dataDir, 'wiki', 'concepts', 'concept-public.meta.json'), meta('concept-public', 'Concept Public'));
writeFileSync(join(dataDir, 'wiki', 'concepts', 'hidden-concept.md'), '# Hidden concept\n\nCANARYHCON shared guide');
writeFileSync(join(dataDir, 'wiki', 'concepts', 'hidden-concept.meta.json'), meta('hidden-concept', 'CANARYHCON', { visibility: 'internal' }));
// M1 fixtures: huge public pages, not matched by any search in this test.
const BIG_SLUGS = Array.from({ length: 6 }, (_, i) => `big-${i}`);
page('emoji-page', 'Emoji', `EMOJISTART${'a'.repeat(7999 - 'EMOJISTART'.length)}\u{1F600}${'b'.repeat(100)}`);
BIG_SLUGS.forEach((slug, i) => page(slug, `Big ${i}`, `BIGSTART${i} ${'lorem ipsum '.repeat(5000)} BIGEND${i}`));
writeFileSync(join(dataDir, 'wiki', 'concepts', 'second-public.md'), '# Concept\n\nCANARYCONCEPT shared guide');
writeFileSync(join(dataDir, 'wiki', 'concepts', 'second-public.meta.json'), meta('second-public', 'CANARYCONCEPT', { visibility: 'pii' }));
const projNotes = join(dataDir, 'projects', 'p1', 'wiki', 'notes');
mkdirSync(projNotes, { recursive: true });
writeFileSync(join(projNotes, 'proj-only.md'), '# Proj\n\nCANARYPROJ shared guide');
writeFileSync(join(projNotes, 'proj-only.meta.json'), meta('proj-only', 'CANARYPROJ'));
mkdirSync(join(dataDir, 'raw'), { recursive: true });
writeFileSync(join(dataDir, 'raw', 'dump.md'), 'CANARYRAW shared guide');
mkdirSync(join(dataDir, 'chats'), { recursive: true });
writeFileSync(join(dataDir, 'chats', 'c1.json'), JSON.stringify({ id: 'c1', title: 'CANARYCHAT', messages: [] }));
writeFileSync(join(dataDir, 'mindbase.config.json'), JSON.stringify({ provider: 'ollama', model: 'mock-model', apiKey: 'unused', baseUrl: MOCK_URL }));
// Flipped to pii after the server built its search index (index rows must not be trusted).
const flipToPii = () => writeFileSync(join(notesDir, 'flip-page.meta.json'), meta('flip-page', 'Flip', { visibility: 'pii' }));

let exitCode = 0;
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => { console.error(`FAIL ${msg}`); exitCode = 1; };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));
const leaks = (text) => CANARIES.filter((c) => text.includes(c));

function startServer(env) {
  return spawn('node', ['dist/http.js'], {
    env: { ...process.env, MINDBASE_DATA_DIR: dataDir, MCP_HTTP_PORT: String(PORT), MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_TOKEN: FULL, MCP_HTTP_READONLY_TOKEN: RO, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitForExit = (proc, ms) => new Promise((resolve) => {
  if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
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
  const client = new Client({ name: 'ask-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
async function call(client, name, args) {
  try { return (await client.callTool({ name, arguments: args })).content.map((c) => c.text ?? '').join(''); } catch (e) { return `THROWN ${e.message}`; }
}
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/db\.sqlite-(shm|wal)$/.test(p)) { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

async function startupValidation() {
  for (const [name, value] of [['MCP_HTTP_READONLY_LLM_RATE', 'abc'], ['MCP_HTTP_READONLY_LLM_RATE', '-1'], ['MCP_HTTP_READONLY_LLM_RATE', '2.5'],
    ['MCP_HTTP_READONLY_LLM_RATE_TOTAL', 'x'], ['MCP_HTTP_READONLY_LLM_WINDOW_MS', '10']]) {
    const proc = startServer({ [name]: value });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    const code = await waitForExit(proc, 8000);
    if (code === null) proc.kill('SIGKILL');
    check(code !== null && code !== 0 && stderr.includes(name), `startup: ${name}=${value} refused`, `code=${code} ${stderr.slice(0, 200)}`);
  }
}

async function run() {
  check(READ_ONLY_TOOL_NAMES.length === 13 && READ_ONLY_TOOL_NAMES.includes('ask_wiki'), 'allowlist: 13 tools incl. ask_wiki');
  await startupValidation();

  const proc = startServer({ MCP_HTTP_READONLY_LLM_RATE: '3', MCP_HTTP_READONLY_LLM_RATE_TOTAL: '4' });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen\n${stderr}`); return; }
    flipToPii();
    const full = await connect(FULL);
    const ro = await connect(RO);
    check((await ro.listTools()).tools.some((t) => t.name === 'ask_wiki'), 'readonly: tools/list contains ask_wiki');
    check(/ask_wiki/.test(ro.getInstructions() ?? ''), 'readonly: reader instructions mention ask_wiki');

    // Precondition: the full profile sends hidden content, so the reader check is meaningful.
    const before = llmRequests.length;
    const fullAnswer = await call(full, 'ask_wiki', { question: 'shared guide', context_pages: ['internal-page'] });
    check(llmRequests.length === before + 1 && llmRequests.at(-1).includes('CANARYINT') && fullAnswer.includes('Mock answer'),
      'full: ask_wiki reaches LLM with internal content', fullAnswer.slice(0, 200));

    const snap = snapshot(dataDir);

    // Reader: hidden pages named explicitly + a question matching hidden pages.
    let n = llmRequests.length;
    const roAnswer = await call(ro, 'ask_wiki', {
      // The question is the reader's own text and is sent as-is, so it carries no canary.
      question: 'shared guide internal pii', context_pages: [...HIDDEN_SLUGS, 'second-public', 'concept-public'], max_pages: 20,
    });
    const prompt = llmRequests.slice(n).join('\n');
    check(llmRequests.length === n + 1, 'readonly: ask_wiki called the LLM once', roAnswer.slice(0, 300));
    check(prompt.includes('PUBLICMARKER') && prompt.includes('SECONDMARKER'), 'readonly: visible pages are sent as context', prompt.slice(0, 300));
    check(prompt.includes('CONCEPTMARKER'), 'readonly: visible concept-layer page is used as context', prompt.slice(0, 300));
    check(leaks(prompt).length === 0, 'readonly: prompt contains no canary from hidden pages', leaks(prompt).join(','));
    check(leaks(roAnswer).length === 0, 'readonly: response contains no canary', leaks(roAnswer).join(','));
    const hiddenInAnswer = HIDDEN_SLUGS.filter((s) => roAnswer.includes(s));
    check(hiddenInAnswer.length === 0, 'readonly: response echoes no hidden slug', `${hiddenInAnswer.join(',')} ${roAnswer.slice(0, 400)}`);

    // Reader: only hidden pages → nothing to send, no LLM call.
    n = llmRequests.length;
    const onlyHidden = await call(ro, 'ask_wiki', { question: 'CANARYINT CANARYPII CANARYFLIP', context_pages: HIDDEN_SLUGS });
    check(llmRequests.length === n && leaks(onlyHidden).length === 0 && !HIDDEN_SLUGS.some((s) => onlyHidden.includes(s)),
      'readonly: only hidden pages → no LLM call, no echo', onlyHidden.slice(0, 200));

    // Provider errors are not passed through to readers (may contain internal hosts or prompt echoes).
    n = llmRequests.length;
    const providerError = await call(ro, 'ask_wiki', { question: 'shared guide FAILME' });
    check(llmRequests.length === n + 1 && /error/i.test(providerError) && !providerError.includes('PROVIDERDETAIL') && !providerError.includes('10.0.0.5'),
      'readonly: LLM provider error is generic', providerError.slice(0, 200));

    check(snapshot(dataDir) === snap, 'readonly: ask_wiki wrote nothing to the data dir');

    // M2: calls that make no provider request never consume the budget.
    n = llmRequests.length;
    const freeCalls = [
      { question: '' }, { question: 'x'.repeat(2001) }, { question: 'CANARYINT', context_pages: ['internal-page'] },
      { question: 'q', context_pages: Array.from({ length: 21 }, () => 'public-page') },
    ];
    for (let i = 0; i < 100; i++) await call(ro, 'ask_wiki', freeCalls[i % freeCalls.length]);
    check(llmRequests.length === n, 'readonly: 100 failing calls made no LLM request');

    // M1: oversized question rejected without LLM call.
    const longQ = await call(ro, 'ask_wiki', { question: 'shared guide '.repeat(200) });
    check(llmRequests.length === n && /invalid input/i.test(longQ), 'readonly: question over 2000 chars rejected, no LLM call', longQ.slice(0, 200));

    // Rate limit: per session 3 (two provider requests above), per token 4.
    n = llmRequests.length;
    const third = await call(ro, 'ask_wiki', { question: 'shared guide' });
    check(third.includes('Mock answer') && llmRequests.length === n + 1, 'readonly: 3rd provider request within session limit (failing calls did not count)', third.slice(0, 200));
    n = llmRequests.length;
    const fourth = await call(ro, 'ask_wiki', { question: 'shared guide' });
    check(/rate limit/i.test(fourth) && llmRequests.length === n, 'readonly: 4th provider request in session → rate limit error, no LLM call', fourth.slice(0, 200));
    const ro2 = await connect(RO);
    n = llmRequests.length;
    const other = await call(ro2, 'ask_wiki', { question: 'shared guide' });
    check(other.includes('Mock answer') && llmRequests.length === n + 1, 'readonly: new session has its own session budget', other.slice(0, 200));
    n = llmRequests.length;
    const overToken = await call(ro2, 'ask_wiki', { question: 'shared guide' });
    check(/rate limit/i.test(overToken) && llmRequests.length === n, 'readonly: token-wide limit across sessions → error, no LLM call', overToken.slice(0, 200));
    check((await call(ro2, 'search_wiki', { query: 'shared guide' })).includes('public-page'), 'readonly: non-LLM tools unaffected by rate limit');

    n = llmRequests.length;
    for (let i = 0; i < 5; i++) await call(full, 'ask_wiki', { question: 'shared guide' });
    check(llmRequests.length === n + 5, 'full: ask_wiki not rate limited');

    // M1: caps for the full profile too.
    n = llmRequests.length;
    const fullLongQ = await call(full, 'ask_wiki', { question: 'q'.repeat(2001) });
    check(llmRequests.length === n && /invalid input/i.test(fullLongQ), 'full: question over 2000 chars rejected, no LLM call', fullLongQ.slice(0, 200));
    const fullManyPages = await call(full, 'ask_wiki', { question: 'q', context_pages: Array.from({ length: 21 }, (_, i) => `p${i}`) });
    check(llmRequests.length === n && /invalid input/i.test(fullManyPages), 'full: more than 20 context_pages rejected, no LLM call', fullManyPages.slice(0, 200));
    const bigAnswer = await call(full, 'ask_wiki', { question: 'zzqq', context_pages: BIG_SLUGS, max_pages: 20 });
    const bigBody = llmRequests.length === n + 1 ? JSON.parse(llmRequests.at(-1)) : null;
    const bigContent = bigBody?.messages?.[0]?.content ?? '';
    check(bigAnswer.includes('Mock answer') && bigContent.length > 0 && bigContent.length <= 42000 && bigContent.includes('BIGSTART0'),
      'full: oversized page bodies truncated to a bounded prompt', `len=${bigContent.length}`);
    const ctxBlock = bigContent.slice(bigContent.indexOf('# Wiki context') + '# Wiki context'.length, bigContent.lastIndexOf('\n\n# Question'));
    check(ctxBlock.length > 39000 && ctxBlock.length <= 40000 && ctxBlock.endsWith('[… truncated]'),
      'full: context block incl. truncation mark stays within 40000 chars', `len=${ctxBlock.length}`);
    const bigAgain = await call(full, 'ask_wiki', { question: 'zzqq', context_pages: BIG_SLUGS, max_pages: 20 });
    check(bigAgain.includes('Mock answer') && JSON.parse(llmRequests.at(-1)).messages[0].content === bigContent, 'full: truncation is deterministic');
    check(llmRequests.at(-1).length < 60000, 'readonly/full: request body bounded');
    // N1: a cut never splits a surrogate pair (emoji straddles the 8000-char body cut).
    await call(full, 'ask_wiki', { question: 'zzqq', context_pages: ['emoji-page'] });
    const emojiContent = JSON.parse(llmRequests.at(-1)).messages[0].content;
    check(emojiContent.includes('EMOJISTART') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiContent),
      'full: truncation leaves no lone surrogate');

    // Central slug check for context_pages and ingest_plan.raw_id (all profiles).
    n = llmRequests.length;
    const badCtx = [];
    for (const slug of ['../../raw/dump', '..', 'a\\b', '/etc/passwd', 'x/../y']) {
      for (const [client, label] of [[full, 'full'], [ro2, 'ro']]) {
        const t = await call(client, 'ask_wiki', { question: 'shared guide', context_pages: ['public-page', slug] });
        if (!t.includes(UNSAFE_SLUG_ERROR)) badCtx.push(`${label} ${slug} → ${t.slice(0, 80)}`);
      }
      const t = await call(full, 'ingest_plan', { raw_id: slug });
      if (!t.includes(UNSAFE_SLUG_ERROR)) badCtx.push(`ingest_plan ${slug} → ${t.slice(0, 80)}`);
    }
    check(badCtx.length === 0 && llmRequests.length === n, 'all profiles: unsafe context_pages / raw_id rejected centrally', badCtx.join(' | '));
    const legit = await call(full, 'ask_wiki', { question: 'shared guide', context_pages: ['x..y', 'public-page'] });
    check(!legit.includes(UNSAFE_SLUG_ERROR), 'full: dotted legit context page passes slug check', legit.slice(0, 120));

    for (const c of [full, ro, ro2]) await c.close().catch(() => {});
  } catch (e) {
    fail(`${e.message}\n${stderr}`);
  } finally {
    proc.kill('SIGTERM');
    await waitForExit(proc, 5000);
  }
  await unexpectedErrorIsGeneric();
}

/** L2: an exception inside ask_wiki (here: unavailable provider) yields a generic error; detail goes to the server log. */
async function unexpectedErrorIsGeneric() {
  writeFileSync(join(dataDir, 'mindbase.config.json'), JSON.stringify({ provider: 'atlas', model: 'mock-model', apiKey: 'unused', baseUrl: MOCK_URL }));
  const proc = startServer({});
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    if (!(await waitForPort(20000))) { fail(`server did not listen\n${stderr}`); return; }
    for (const [token, label] of [[RO, 'readonly'], [FULL, 'full']]) {
      const client = await connect(token);
      const text = await call(client, 'ask_wiki', { question: 'shared guide' });
      check(/ask_wiki failed/.test(text) && !/atlas/i.test(text), `${label}: unexpected ask_wiki failure returns a generic error`, text.slice(0, 200));
      await client.close().catch(() => {});
    }
    check(/atlas/i.test(stderr), 'unexpected ask_wiki failure detail is logged server-side', stderr.slice(-300));
  } finally {
    proc.kill('SIGTERM');
    await waitForExit(proc, 5000);
  }
}

run()
  .catch((e) => fail(e.message))
  .finally(() => { mock.close(); rmSync(dataDir, { recursive: true, force: true }); process.exit(exitCode); });
