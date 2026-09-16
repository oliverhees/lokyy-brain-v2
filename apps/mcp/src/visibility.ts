// apps/mcp/src/visibility.ts
// Reader view for read-only sessions (LBV2-12). Wiki pages whose meta says
// visibility "internal" or "pii" must be invisible to readers: not listed, not
// searchable, not readable, and indistinguishable from a page that does not exist.
//
// One mechanism instead of per-tool patches: read-only sessions get a filtered
// Context built from plain objects that expose only the members the allowlisted
// tools and resources need. Everything is fail closed:
//
// - Scope: readers see the ROOT wiki only (`wiki/notes`, `wiki/concepts`, index
//   project "default"). Project wikis (`projects/*`), project context, sources,
//   raw files, chats and every other path are invisible, even when a project
//   page's own meta says "public". Rationale: project meta is not reviewed for
//   reader exposure and the tools address pages by bare slug, so a strict root
//   scope is the only rule that cannot be bypassed with a crafted slug.
// - Store: strict allowlist. Only `wiki/(notes|concepts)/<slug>.(md|meta.json)`
//   of a page whose own meta is public, plus listings of those two directories.
//   Everything else fails with the same relative "Not found" error.
// - Visibility is decided from meta files on disk, keyed by (layer, slug), and
//   re-checked right before a page file is returned. Index rows (sqlite) are
//   never trusted for visibility: they can be stale and do not record the layer.
//   Index-derived views (graph, page rows, cards) show a slug only if it exists
//   in the root wiki and no layer holds a hidden page with that slug.
// - Links to hidden pages stay in the graph as broken links, exactly like links
//   to pages that do not exist, so link lists are no existence oracle.
// - Search returns rank only; raw scores would reveal statistics of hidden pages.
import type { CardStore, DirEntry, FeedStore, PageGraph, PageNode, PageRow, ReviewCard, SearchIndex, Store, WikiIndex } from '@mindbase/core';
import type { Context } from './context.js';

const WIKI_LAYERS = ['notes', 'concepts'] as const;
const PAGE_FILE = /^wiki\/(notes|concepts)\/([^/\\\0]+?)(\.md|\.meta\.json)$/;
const LAYER_DIR = /^wiki\/(notes|concepts)$/;
const ROOT_PROJECT = 'default';

export interface ReaderView {
  /** Context whose data accessors only expose pages visible to readers. */
  ctx: Context;
  /** Re-reads page visibility from disk; call before serving each request. */
  refresh: () => Promise<void>;
}

interface VisibleSet {
  /** Page markdown files whose own meta is public, e.g. `wiki/concepts/<slug>.md`. */
  files: ReadonlySet<string>;
  /** Slugs safe for slug-keyed views: a public page exists and no layer hides that slug. */
  slugs: ReadonlySet<string>;
}

function isPublicMeta(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  const visibility = (meta as { visibility?: unknown }).visibility;
  return visibility === undefined || visibility === null || visibility === 'public';
}

/** Same error for hidden, disallowed and nonexistent paths; relative path only. */
function notFound(p: string): Error {
  const shown = PAGE_FILE.test(p) || LAYER_DIR.test(p) ? p : 'requested path';
  return Object.assign(new Error(`Not found: ${shown}`), { code: 'ENOENT' });
}

async function loadVisibleSet(store: Store): Promise<VisibleSet> {
  const files = new Set<string>();
  const publicSlugs = new Set<string>();
  const hiddenSlugs = new Set<string>();
  for (const layer of WIKI_LAYERS) {
    let entries: DirEntry[] = [];
    try { entries = await store.listDir(`wiki/${layer}`); } catch { continue; }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.slice(0, -'.md'.length);
      let visible = false;
      try { visible = isPublicMeta(await store.readJSON<unknown>(`wiki/${layer}/${slug}.meta.json`)); } catch { /* unreadable meta → hidden */ }
      if (!visible) { hiddenSlugs.add(slug); continue; }
      files.add(`wiki/${layer}/${entry.name}`);
      publicSlugs.add(slug);
    }
  }
  return { files, slugs: new Set([...publicSlugs].filter((s) => !hiddenSlugs.has(s))) };
}

/**
 * Keeps the visible nodes. Edges from hidden sources are dropped; edges into
 * pages that are not visible are kept as broken links, exactly like links to
 * pages that do not exist.
 */
export function filterGraph(graph: PageGraph, isVisible: (node: PageNode) => boolean): PageGraph {
  const nodes = new Map<string, PageNode>();
  for (const [id, node] of graph.nodes) if (isVisible(node)) nodes.set(id, node);
  const edges = graph.edges
    .filter((e) => nodes.has(e.source))
    .map((e) => (nodes.has(e.target) ? e : { ...e, broken: true }));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    if (!e.broken) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }
  return { nodes, edges, incoming, outgoing };
}

export function createReaderView(base: Context): ReaderView {
  let visible: VisibleSet = { files: new Set(), slugs: new Set() }; // empty until refreshed → fail closed

  const slugVisible = (projectId: string | undefined, slug: string): boolean =>
    projectId === ROOT_PROJECT && visible.slugs.has(slug);
  const nodeVisible = (node: PageNode): boolean => !node.crossProjectStub && slugVisible(node.projectId, node.slug);
  const rowVisible = (row: PageRow): boolean => slugVisible(row.project_id, row.slug);
  const cardVisible = (card: ReviewCard): boolean => typeof card.source_slug === 'string' && visible.slugs.has(card.source_slug);

  /** Strict allowlist gate: returns the page's markdown path, or throws notFound. */
  const gate = (p: string): { file: string; meta: string } => {
    const m = PAGE_FILE.exec(p);
    const file = m ? `wiki/${m[1]}/${m[2]}.md` : '';
    if (!m || !visible.files.has(file)) throw notFound(p);
    return { file, meta: `wiki/${m[1]}/${m[2]}.meta.json` };
  };
  /** Reads an allowed page file and re-checks the page's meta right before returning (TOCTOU). */
  const read = async <T>(p: string, fn: (safe: string) => Promise<T>): Promise<T> => {
    const { meta } = gate(p);
    try {
      const value = await fn(p);
      if (!isPublicMeta(await base.store.readJSON<unknown>(meta))) throw notFound(p);
      return value;
    } catch { throw notFound(p); }
  };
  const readOnly = (): Promise<never> => Promise.reject(new Error('read-only session'));

  const store: Store = {
    readText: (p) => read(p, (s) => base.store.readText(s)),
    readJSON: <T>(p: string) => read(p, (s) => base.store.readJSON<T>(s)),
    readBinary: (p) => read(p, (s) => base.store.readBinary(s)),
    exists: async (p) => { try { return await read(p, (s) => base.store.exists(s)); } catch { return false; } },
    listDir: async (p) => {
      if (!LAYER_DIR.test(p)) throw notFound(p);
      const entries = await base.store.listDir(p).catch(() => { throw notFound(p); });
      return entries.filter((e) => {
        const m = PAGE_FILE.exec(`${p}/${e.name}`);
        return e.kind === 'file' && m !== null && visible.files.has(`${p}/${m[2]}.md`);
      });
    },
    writeText: readOnly,
    writeJSON: readOnly,
    writeBinary: readOnly,
    remove: readOnly,
  };

  const searchIndex: Pick<SearchIndex, 'search'> = {
    search: (query) => {
      const hits = base.searchIndex.search(query).filter((hit) => visible.files.has(hit.path));
      return hits.map((hit, i) => ({ ...hit, score: hits.length - i }));
    },
  };

  const wikiIndex: Pick<WikiIndex, 'buildGraph' | 'allPages' | 'getPage'> = {
    buildGraph: (opts) => filterGraph(base.wikiIndex.buildGraph(opts), nodeVisible),
    allPages: () => base.wikiIndex.allPages().filter(rowVisible),
    getPage: (slug) => {
      const row = base.wikiIndex.getPage(slug);
      return row && rowVisible(row) ? row : null;
    },
  };

  const cards: Pick<CardStore, 'list' | 'findDue'> = {
    list: async (opts) => (await base.cards.list(opts)).filter(cardVisible),
    findDue: async (now = new Date(), limit = 50) => {
      const due = (await base.cards.list()).filter((c) => cardVisible(c) && new Date(c.due_at).getTime() <= now.getTime());
      return { cards: due.slice(0, limit), total: due.length };
    },
  };

  const feeds: Pick<FeedStore, 'summaries'> = { summaries: () => base.feeds.summaries() };

  // Deliberately absent: dataDir (absolute path), config (API key), synthesisCache,
  // templates. Tools needing them are not allowlisted; a missing member fails loudly.
  const readerCtx = {
    store,
    searchIndex,
    wikiIndex,
    cards,
    feeds,
    getAdapter: (): never => { throw new Error('LLM access is not available to read-only sessions'); },
    reindex: readOnly,
    mcpClient: base.mcpClient,
    allowLocalFilePaths: false,
  };

  return {
    // Tools are typed against the full Context; the reader context is a strict subset by design.
    ctx: readerCtx as unknown as Context,
    refresh: async () => { visible = await loadVisibleSet(base.store); },
  };
}
