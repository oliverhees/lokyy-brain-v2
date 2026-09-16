// apps/mcp/src/visibility.ts
// Reader view for read-only sessions (LBV2-12). Wiki pages whose meta says
// visibility "internal" or "pii" must be invisible to readers: not listed, not
// searchable, not linked, and unreadable with the same error as a missing page.
//
// One mechanism instead of per-tool patches: read-only sessions get a filtered
// Context. Store, search index, wiki index and card store are wrapped so every
// allowlisted tool and resource only ever sees visible pages. The visible set is
// rebuilt from the wiki meta files before each request (refresh) and is fail
// closed: a page is visible only if its meta parses and its visibility is absent
// or "public". Anything the wrappers do not explicitly support throws.
import path from 'node:path';
import type { CardStore, DirEntry, PageGraph, PageNode, PageRow, ReviewCard, SearchIndex, Store, WikiIndex } from '@mindbase/core';
import type { Context } from './context.js';

const WIKI_LAYERS = ['notes', 'concepts'] as const;
const PAGE_FILE = /^wiki\/(notes|concepts)\/([^/]+?)(\.md|\.meta\.json)$/;

export interface ReaderView {
  /** Context whose data accessors only expose pages visible to readers. */
  ctx: Context;
  /** Re-reads page visibility from disk; call before serving each request. */
  refresh: () => Promise<void>;
}

interface VisibleSet {
  /** Page markdown paths, e.g. `wiki/notes/<slug>.md`. */
  paths: ReadonlySet<string>;
  slugs: ReadonlySet<string>;
}

function isPublicMeta(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  const visibility = (meta as { visibility?: unknown }).visibility;
  return visibility === undefined || visibility === null || visibility === 'public';
}

/** Same error for hidden and nonexistent paths, relative path only. */
function notFound(p: string): Error {
  return Object.assign(new Error(`Not found: ${p}`), { code: 'ENOENT' });
}

function normalize(p: string): string | null {
  const n = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  return n.startsWith('..') || n.startsWith('/') ? null : n;
}

async function loadVisibleSet(store: Store): Promise<VisibleSet> {
  const paths = new Set<string>();
  const slugs = new Set<string>();
  for (const layer of WIKI_LAYERS) {
    let entries: DirEntry[] = [];
    try { entries = await store.listDir(`wiki/${layer}`); } catch { continue; }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.slice(0, -'.md'.length);
      try {
        if (!isPublicMeta(await store.readJSON<unknown>(`wiki/${layer}/${slug}.meta.json`))) continue;
      } catch { continue; } // unreadable meta → hidden
      paths.add(`wiki/${layer}/${entry.name}`);
      slugs.add(slug);
    }
  }
  return { paths, slugs };
}

/** Proxy exposing only the given members; any other access fails loudly. */
function restrict<T extends object>(target: T, name: string, members: Partial<T>): T {
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(members, prop)) return members[prop as keyof T];
      throw new Error(`${name}.${prop} is not available to read-only sessions`);
    },
  });
}

export function filterGraph(graph: PageGraph, isVisible: (node: PageNode) => boolean): PageGraph {
  const nodes = new Map<string, PageNode>();
  const hidden = new Set<string>();
  for (const [id, node] of graph.nodes) {
    if (isVisible(node)) nodes.set(id, node);
    else hidden.add(id);
  }
  // Edges into hidden pages are dropped entirely (not turned into broken links),
  // so their slugs never surface in link lists or broken-link reports.
  const edges = graph.edges.filter((e) => nodes.has(e.source) && !hidden.has(e.target));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    if (!e.broken) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }
  return { nodes, edges, incoming, outgoing };
}

export function createReaderView(base: Context): ReaderView {
  let visible: VisibleSet = { paths: new Set(), slugs: new Set() }; // empty until refreshed → fail closed

  const pathVisible = (p: string): boolean => {
    const n = normalize(p);
    return n !== null && visible.paths.has(n);
  };
  const nodeVisible = (node: PageNode): boolean =>
    !node.crossProjectStub && isPublicMeta({ visibility: node.visibility }) && pathVisible(node.path);
  const rowVisible = (row: PageRow): boolean => isPublicMeta({ visibility: row.visibility }) && pathVisible(row.path);
  const cardVisible = (card: ReviewCard): boolean => card.source_slug === undefined || visible.slugs.has(card.source_slug);

  /** Whitelist gate for store paths: wiki content only for visible pages; chats never. */
  const gate = (p: string): string => {
    const n = normalize(p);
    if (n === null || n === 'chats' || n.startsWith('chats/')) throw notFound(p);
    if (n !== 'wiki' && !n.startsWith('wiki/')) return n;
    const m = PAGE_FILE.exec(n);
    if (!m || !visible.paths.has(`wiki/${m[1]}/${m[2]}.md`)) throw notFound(n);
    return n;
  };
  const read = async <T>(p: string, fn: (safe: string) => Promise<T>): Promise<T> => {
    const safe = gate(p);
    try { return await fn(safe); } catch { throw notFound(safe); }
  };

  const store: Store = {
    readText: (p) => read(p, (s) => base.store.readText(s)),
    readJSON: <T>(p: string) => read(p, (s) => base.store.readJSON<T>(s)),
    readBinary: (p) => read(p, (s) => base.store.readBinary(s)),
    exists: async (p) => { let safe: string; try { safe = gate(p); } catch { return false; } return base.store.exists(safe); },
    listDir: async (p) => {
      const n = normalize(p);
      const layer = WIKI_LAYERS.find((l) => n === `wiki/${l}`);
      if (n === null || (n.startsWith('wiki') && !layer) || n === 'chats' || n.startsWith('chats/')) throw notFound(p);
      const entries = await base.store.listDir(n).catch(() => { throw notFound(n); });
      if (!layer) return entries;
      return entries.filter((e) => {
        const m = PAGE_FILE.exec(`${n}/${e.name}`);
        return e.kind === 'file' && m !== null && visible.paths.has(`${n}/${m[2]}.md`);
      });
    },
    writeText: () => Promise.reject(new Error('read-only session')),
    writeJSON: () => Promise.reject(new Error('read-only session')),
    writeBinary: () => Promise.reject(new Error('read-only session')),
    remove: () => Promise.reject(new Error('read-only session')),
  };

  const searchIndex = restrict<SearchIndex>(base.searchIndex, 'searchIndex', {
    search: (query: string) => base.searchIndex.search(query).filter((hit) => pathVisible(hit.path)),
  });

  const wikiIndex = restrict<WikiIndex>(base.wikiIndex, 'wikiIndex', {
    buildGraph: (opts?: { projectId?: string }) => filterGraph(base.wikiIndex.buildGraph(opts), nodeVisible),
    allPages: () => base.wikiIndex.allPages().filter(rowVisible),
    getPage: (slug: string) => {
      const row = base.wikiIndex.getPage(slug);
      return row && rowVisible(row) ? row : null;
    },
  });

  const cards = restrict<CardStore>(base.cards, 'cards', {
    list: async (opts?: { include_archived?: boolean }) => (await base.cards.list(opts)).filter(cardVisible),
    findDue: async (now: Date = new Date(), limit = 50) => {
      const due = (await base.cards.list()).filter((c) => cardVisible(c) && new Date(c.due_at).getTime() <= now.getTime());
      return { cards: due.slice(0, limit), total: due.length };
    },
  });

  const ctx: Context = {
    ...base,
    store,
    searchIndex,
    wikiIndex,
    cards,
    getAdapter: () => { throw new Error('LLM access is not available to read-only sessions'); },
    reindex: () => Promise.reject(new Error('read-only session')),
    allowLocalFilePaths: false,
  };

  return {
    ctx,
    refresh: async () => { visible = await loadVisibleSet(base.store); },
  };
}
