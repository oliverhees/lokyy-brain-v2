// apps/mcp/src/tools/ask-wiki.ts
import { z } from 'zod';
import type { Context } from '../context.js';
import { textResult, errorResult } from '../lib/error.js';
import type { MetaJson } from '@mindbase/core';

/** Input and prompt bounds (LBV2-18 M1), for every profile. */
export const MAX_QUESTION_CHARS = 2000;
export const MAX_CONTEXT_PAGES = 20;
/** Per-page body cap; longer bodies are cut at this length. */
export const MAX_PAGE_BODY_CHARS = 8000;
/** Cap for the whole context block; pages are added in order until it is reached. */
export const MAX_CONTEXT_CHARS = 40000;
const TRUNCATION_MARK = '\n\n[… truncated]';

const inputSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
  context_pages: z.array(z.string()).max(MAX_CONTEXT_PAGES).optional(),
  max_pages: z.number().int().min(1).max(20).optional().default(8),
});

export const definition = {
  name: 'ask_wiki',
  description: 'Ask a natural-language question against the user\'s wiki. Performs graph-aware retrieval (search → top hits + their 1-hop wikilinks) and returns a cited answer using the configured LLM. Best tool for "what do I know about X?" questions. The answer text contains [N] citation markers — match each N to the corresponding entry in the citations array and render as a clickable link to mindbase_uri.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: `The natural-language question (max ${MAX_QUESTION_CHARS} characters)` },
      context_pages: { type: 'array', items: { type: 'string' }, description: `Optional: explicit page slugs to include as context (max ${MAX_CONTEXT_PAGES})` },
      max_pages: { type: 'number', description: 'Cap on total pages read (default 8, max 20)' },
    },
    required: ['question'],
  },
};

const WIKI_LAYERS = ['notes', 'concepts'] as const;

/** First `max` UTF-16 code units, one fewer if the cut would split a surrogate pair. */
function cutAt(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Slug of a search hit path in the root wiki (`wiki/notes/<slug>.md` or `wiki/concepts/<slug>.md`). */
function hitSlug(path: string): string {
  return path
    .replace(/^projects\/[^/]+\/(sources\/(?:contributors\/[^/]+|research)|context\.md)\/?/, '')
    .replace(/^wiki\/(notes|concepts)\//, '')
    .replace(/\.md$/, '');
}

/** Reads a page from the first layer that has it (notes, then concepts); null when none is readable. */
async function readPage(ctx: Context, slug: string): Promise<{ body: string; title: string; one_liner?: string } | null> {
  for (const layer of WIKI_LAYERS) {
    let body: string;
    try { body = await ctx.store.readText(`wiki/${layer}/${slug}.md`); } catch { continue; }
    let title = slug;
    let one_liner: string | undefined;
    try {
      const m = await ctx.store.readJSON<MetaJson>(`wiki/${layer}/${slug}.meta.json`);
      title = m.title;
      one_liner = m.one_liner;
    } catch { /* ok */ }
    return { body, title, one_liner };
  }
  return null;
}

export async function handle(ctx: Context, rawInput: unknown) {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.issues[0]?.message ?? 'parse error'}`);
  const { question, context_pages, max_pages } = parsed.data;
  if (!ctx.config) return errorResult('LLM not configured', 'Open MindBase Settings to configure your LLM.');

  try {
    const graph = ctx.wikiIndex.buildGraph();
    const seedSlugs = new Set<string>();

    // Seed: explicit context pages + top search hits
    if (context_pages) for (const s of context_pages) seedSlugs.add(s);
    const hits = ctx.searchIndex.search(question).slice(0, 5);
    for (const h of hits) seedSlugs.add(hitSlug(h.path));

    // Expand: each seed gets 1-hop wikilinks added
    const expanded = new Set(seedSlugs);
    for (const seed of seedSlugs) {
      for (const n of graph.outgoing.get(seed) ?? []) expanded.add(n);
      for (const n of graph.incoming.get(seed) ?? []) expanded.add(n);
    }

    // Cap
    const slugs = [...expanded].slice(0, max_pages);

    // Build context document; bodies and the whole block are cut deterministically (M1).
    let contextBlock = '';
    const citations: Array<{
      n: number;
      slug: string;
      title: string;
      one_liner?: string;
      mindbase_uri: string;
      relevance: number;
    }> = [];
    let i = 1;
    for (const slug of slugs) {
      const remaining = MAX_CONTEXT_CHARS - contextBlock.length;
      if (remaining <= 0) break;
      const page = await readPage(ctx, slug);
      if (!page) continue;
      const body = page.body.length > MAX_PAGE_BODY_CHARS ? `${cutAt(page.body, MAX_PAGE_BODY_CHARS)}${TRUNCATION_MARK}` : page.body;
      let section = `\n\n## [${i}] ${page.title} (slug: ${slug})\n\n${body}`;
      // The mark counts toward the cap, so the block never exceeds MAX_CONTEXT_CHARS.
      if (section.length > remaining) {
        if (remaining <= TRUNCATION_MARK.length) break;
        section = `${cutAt(section, remaining - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
      }
      contextBlock += section;
      citations.push({
        n: i,
        slug,
        title: page.title,
        one_liner: page.one_liner,
        mindbase_uri: `mindbase://wiki/${slug}`,
        relevance: seedSlugs.has(slug) ? 1.0 : 0.5,
      });
      i++;
    }

    if (citations.length === 0) {
      return errorResult('No relevant pages found', 'Try a different question or use search_wiki to explore.');
    }

    const adapter = ctx.getAdapter();
    const promptInstructions = `You are answering a question using the user's compiled wiki content provided below. Cite sources using bracket numbers [N] matching the section headers. Don't fabricate. If the wiki doesn't cover the answer, say so plainly.`;
    const userMessage = `${promptInstructions}\n\n# Wiki context${contextBlock}\n\n# Question\n\n${question}`;

    let answer = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    for await (const chunk of adapter.chat({
      model: ctx.config.model,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 2048,
      temperature: 0.3,
    })) {
      if (chunk.kind === 'delta') answer += chunk.text;
      if (chunk.kind === 'done') usage = chunk.usage;
      if (chunk.kind === 'error') return errorResult(`LLM error: ${chunk.error}`);
    }

    return textResult({
      answer: answer.trim(),
      citations,
      // Only pages that were actually read and sent as context; never unreadable or hidden slugs.
      pages_read: citations.map((c) => c.slug),
      tokens_used: usage,
    });
  } catch (e) {
    // Detail stays in the server log (L2): it may name internal hosts, paths or provider state.
    process.stderr.write(`[mindbase-mcp] ask_wiki failed: ${(e as Error).message}\n`);
    return errorResult('ask_wiki failed', 'See the server log for details.');
  }
}

export function register(handlers: Map<string, (input: unknown) => Promise<unknown>>, defs: object[], ctx: Context): void {
  handlers.set(definition.name, (input) => handle(ctx, input));
  defs.push(definition);
}
