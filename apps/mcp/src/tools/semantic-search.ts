// apps/mcp/src/tools/semantic-search.ts
import { z } from 'zod';
import type { Context } from '../context.js';
import { textResult, errorResult } from '../lib/error.js';
import { EmbeddingStore, guardLlmFetch, remoteEmbedderFromEnv, type MetaJson } from '@mindbase/core';

const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional().default(10),
});

export const definition = {
  name: 'semantic_search',
  description: 'Embedding-based semantic search across the wiki. Falls back to keyword search if embeddings are unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
};

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; ma += a[i]! * a[i]!; mb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}

async function getEmbeddings(texts: string[], baseUrl: string, apiKey: string): Promise<number[][]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/embeddings`;
  // Config URL + API key: host allow-list and no off-host redirects (LBV2-19).
  const r = await guardLlmFetch(fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!r.ok) throw new Error(`Embeddings API: HTTP ${r.status}`);
  const data = await r.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

interface Page { slug: string; title: string; content: string }

/**
 * Pages of both root-wiki layers. Concepts (where compile writes) come first and win a slug that
 * exists in both layers, like the vault's embedding indexer, so cached vectors match (LBV2-32).
 */
async function listPages(ctx: Context): Promise<Page[]> {
  const pages: Page[] = [];
  const seen = new Set<string>();
  for (const layer of ['concepts', 'notes'] as const) {
    let entries: Awaited<ReturnType<Context['store']['listDir']>> = [];
    try { entries = await ctx.store.listDir(`wiki/${layer}`); } catch { continue; }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.replace(/\.md$/, '');
      if (seen.has(slug)) continue;
      let body: string;
      try { body = await ctx.store.readText(`wiki/${layer}/${entry.name}`); } catch { continue; }
      seen.add(slug);
      let title = slug;
      try {
        const m = await ctx.store.readJSON<MetaJson>(`wiki/${layer}/${slug}.meta.json`);
        title = m.title;
      } catch { /* ok */ }
      pages.push({ slug, title, content: body });
    }
  }
  return pages;
}

/**
 * Shared embedding service (LBV2-26, MINDBASE_EMBED_URL + MINDBASE_EMBED_TOKEN): BGE-M3 like the vault
 * server. Only the query is embedded on this path (audit MED-1); page vectors come from the vault
 * server's indexer cache (<dataDir>/embeddings) and are used only while their content hash matches the
 * page ("<title>\n\n<body>", the indexer's format). Pages that are not (or no longer) indexed are left
 * out until the indexer has embedded them; this includes pages whose indexed text contains OCR output.
 */
async function scoreWithEmbedService(ctx: Context, query: string, pages: Page[]): Promise<Array<{ slug: string; title: string; score: number }>> {
  const remote = remoteEmbedderFromEnv(process.env)!;
  const cached = new Map((await new EmbeddingStore(ctx.dataDir).list()).map((e) => [e.slug, e]));
  const indexed = pages.flatMap((p) => {
    const entry = cached.get(p.slug);
    return entry && entry.content_hash === EmbeddingStore.contentHash(`${p.title}\n\n${p.content}`) ? [{ page: p, vector: entry.vector }] : [];
  });
  if (indexed.length === 0) throw new Error('no indexed pages yet');
  const queryEmb = await remote.embed(query);
  return indexed.map(({ page, vector }) => ({ slug: page.slug, title: page.title, score: cosineSim(queryEmb, vector) }));
}

export async function handle(ctx: Context, rawInput: unknown) {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.issues[0]?.message ?? 'parse error'}`);
  const { query, limit } = parsed.data;
  const useEmbedService = Boolean(process.env['MINDBASE_EMBED_URL'] || process.env['MINDBASE_EMBED_TOKEN']);
  if (!useEmbedService && !ctx.config) return errorResult('LLM not configured', 'Open MindBase Settings to set up your LLM provider.');

  try {
    if (useEmbedService) {
      const pages = await listPages(ctx);
      if (pages.length === 0) return textResult([]);
      const scored = (await scoreWithEmbedService(ctx, query, pages)).map((p) => ({ ...p, one_liner: '' }));
      scored.sort((a, b) => b.score - a.score);
      return textResult(scored.slice(0, limit));
    }
    const config = ctx.config!;
    const pages = (await listPages(ctx)).map((p) => ({ ...p, content: p.content.slice(0, 1000) }));
    if (pages.length === 0) return textResult([]);

    const baseUrl = config.baseUrl || 'https://api.openai.com';
    const texts = [query, ...pages.map((p) => `${p.title}: ${p.content}`)];
    const embeds = await getEmbeddings(texts, baseUrl, config.apiKey);
    const queryEmb = embeds[0]!;
    const scored = pages.map((p, i) => ({
      slug: p.slug,
      title: p.title,
      one_liner: '',
      score: cosineSim(queryEmb, embeds[i + 1]!),
    }));
    scored.sort((a, b) => b.score - a.score);
    return textResult(scored.slice(0, limit));
  } catch (e) {
    if (useEmbedService) console.error(`[semantic_search] ${(e as Error).message}; using keyword search`);
    // Fallback to keyword search
    const keyword = ctx.searchIndex.search(query).slice(0, limit);
    const results = await Promise.all(keyword.map(async (h) => {
      const slug = h.path.replace(/^wiki\/(notes|concepts)\//, '').replace(/\.md$/, '');
      let title = slug;
      try {
        const m = await ctx.store.readJSON<MetaJson>(h.path.replace(/\.md$/, '.meta.json'));
        title = m.title;
      } catch { /* ok */ }
      return { slug, title, one_liner: '', score: h.score };
    }));
    return textResult(results);
  }
}

export function register(handlers: Map<string, (input: unknown) => Promise<unknown>>, defs: object[], ctx: Context): void {
  handlers.set(definition.name, (input) => handle(ctx, input));
  defs.push(definition);
}
