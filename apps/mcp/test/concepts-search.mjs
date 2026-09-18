/**
 * LBV2-32: compile writes wiki/concepts, so MCP search_wiki / ask_wiki / semantic_search /
 * read_wiki_page / wiki resources must cover concept pages — including pages another process
 * (the web server) writes after the MCP server started. Readers still never see internal/pii
 * concepts. No network: fetch is stubbed (OpenAI-compatible chat + embeddings).
 * Run from apps/mcp/ after build: node test/concepts-search.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadContext, createMcpServer } from '../dist/index.js';

let exitCode = 0;
const ok = (m) => console.log(`OK: ${m}`);
const fail = (m) => { console.error(`FAIL ${m}`); exitCode = 1; };

const dataDir = mkdtempSync(join(tmpdir(), 'mb-concepts-'));
const wiki = join(dataDir, 'projects', 'default', 'wiki');
mkdirSync(join(wiki, 'notes'), { recursive: true });
mkdirSync(join(wiki, 'concepts'), { recursive: true });
const meta = (slug, title, extra = {}) => JSON.stringify({ id: slug, type: 'concept', title, one_liner: `${title} one-liner`, kind: 'concept', edit_state: 'compiled', last_human_edit: null, created: '2026-09-18T00:00:00Z', updated: '2026-09-18T00:00:00Z', sources: [], related: [], compile_version: 1, word_count: 10, ...extra });
const page = (layer, slug, title, body, extra) => {
  writeFileSync(join(wiki, layer, `${slug}.md`), body);
  writeFileSync(join(wiki, layer, `${slug}.meta.json`), meta(slug, title, extra));
};
page('notes', 'zurich-note', 'Zurich', '# Zurich\n\nZurich is the largest Swiss city.\n');
writeFileSync(join(dataDir, 'mindbase.config.json'), JSON.stringify({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://llm.example/v1' }));

const llmBodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (u.endsWith('/embeddings')) {
    return new Response(JSON.stringify({ data: body.input.map((t) => ({ embedding: /rhine/i.test(t) ? [1, 0] : [0, 1] })) }), { status: 200 });
  }
  llmBodies.push(JSON.stringify(body));
  return new Response('data: {"choices":[{"delta":{"content":"Answer [1]."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
};

async function connect(ctx, profile) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx, profile).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' };
};

process.env.MINDBASE_MCP_INDEX_SYNC_MS = '0';
try {
  const ctx = await loadContext({ dataDir, allowLocalFilePaths: false });
  const full = await connect(ctx, 'full');
  const reader = await connect(ctx, 'readonly');

  // Written by "the web server" after the MCP server started.
  page('concepts', 'rhine-port', 'Rhine port of Basel', '# Rhine port of Basel\n\nThe Rhine port handles Swiss imports. CANARYPUBLIC\n');
  page('concepts', 'rhine-secret', 'Rhine secret', '# Rhine secret\n\nRhine smuggling routes. CANARYHIDDEN\n', { visibility: 'internal' });

  const search = await call(full, 'search_wiki', { query: 'rhine port' });
  const hits = search.isError ? [] : JSON.parse(search.text);
  const port = hits.find((h) => h.slug === 'rhine-port');
  if (port) ok('search_wiki finds a concept written after start'); else fail(`search_wiki: ${search.text.slice(0, 300)}`);
  if (port?.title === 'Rhine port of Basel') ok('search_wiki uses the concept meta title'); else fail(`title ${port?.title}`);
  if (!hits.some((h) => String(h.slug).includes('/'))) ok('search_wiki slugs have no layer prefix'); else fail('layer prefix in slug');

  const ask = await call(full, 'ask_wiki', { question: 'What does the Rhine port handle?' });
  const cites = ask.isError ? [] : JSON.parse(ask.text).citations.map((c) => c.slug);
  if (cites.includes('rhine-port')) ok('ask_wiki cites the concept'); else fail(`ask_wiki: ${ask.text.slice(0, 300)}`);
  if (llmBodies.at(-1)?.includes('CANARYPUBLIC')) ok('concept body reaches the LLM context'); else fail('concept body not in prompt');

  const sem = await call(full, 'semantic_search', { query: 'Rhine' });
  const semHits = sem.isError ? [] : JSON.parse(sem.text);
  if (semHits[0]?.slug === 'rhine-port' || semHits[0]?.slug === 'rhine-secret') ok('semantic_search ranks concepts'); else fail(`semantic_search: ${sem.text.slice(0, 300)}`);

  const read = await call(full, 'read_wiki_page', { slug: 'rhine-port' });
  if (!read.isError && JSON.parse(read.text).body.includes('CANARYPUBLIC')) ok('read_wiki_page reads a concept'); else fail(`read_wiki_page: ${read.text.slice(0, 200)}`);
  const res = await full.readResource({ uri: 'mindbase://wiki/rhine-port' });
  if (res.contents?.[0]?.text?.includes('CANARYPUBLIC')) ok('wiki resource reads a concept'); else fail('resource');
  const list = await full.listResources();
  if (list.resources.some((r) => r.uri === 'mindbase://wiki/rhine-port')) ok('resource list includes concepts'); else fail('resource list');

  // Readers: public concept visible, internal concept never.
  const rs = await call(reader, 'search_wiki', { query: 'rhine' });
  const rHits = rs.isError ? [] : JSON.parse(rs.text);
  if (rHits.some((h) => h.slug === 'rhine-port')) ok('reader search_wiki finds the public concept'); else fail(`reader search: ${rs.text.slice(0, 300)}`);
  if (!rs.text.includes('rhine-secret') && !rs.text.includes('CANARYHIDDEN')) ok('reader search hides the internal concept'); else fail('internal concept leaked in reader search');
  llmBodies.length = 0;
  const ra = await call(reader, 'ask_wiki', { question: 'Rhine port smuggling routes?' });
  if (!ra.isError && JSON.parse(ra.text).citations.some((c) => c.slug === 'rhine-port')) ok('reader ask_wiki cites the public concept'); else fail(`reader ask: ${ra.text.slice(0, 300)}`);
  if (!ra.text.includes('rhine-secret') && !llmBodies.join('').includes('CANARYHIDDEN')) ok('internal concept never reaches reader answer or prompt'); else fail('internal concept leaked via reader ask_wiki');
  const rr = await call(reader, 'read_wiki_page', { slug: 'rhine-secret' });
  if (rr.isError && !rr.text.includes('CANARYHIDDEN')) ok('reader cannot read the internal concept'); else fail('reader read internal concept');

  await full.close();
  await reader.close();
  ctx.wikiIndex.close?.();
} catch (e) {
  fail(e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  globalThis.fetch = realFetch;
  delete process.env.MINDBASE_MCP_INDEX_SYNC_MS;
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
