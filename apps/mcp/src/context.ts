// apps/mcp/src/context.ts
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { FileStore, ProjectScopedStore, SearchIndex, FeedStore, CardStore, TemplateStore, WikiIndex, reindex, createAdapter, isValidProjectId, type LLMAdapter, type Store } from '@mindbase/core';
import { SynthesisCache } from './lib/synthesis-cache.js';
import { extractPdfText } from './lib/extract-pdf.js';
import { createConfigReloader, configReloadIntervalMs } from './lib/config-reloader.js';

export interface MCPConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'ollama';
  model: string;
  apiKey: string;
  baseUrl: string;
  /** EUrouter routing rule (UUID), sent as `rule_id` (LBV2-30). */
  ruleId?: string;
  autoSave?: boolean;
  mergeSaves?: boolean;
  maxContextChars?: number;
}

export interface Context {
  dataDir: string;
  store: Store;
  wikiIndex: WikiIndex;
  searchIndex: SearchIndex;
  feeds: FeedStore;
  cards: CardStore;
  templates: TemplateStore;
  synthesisCache: SynthesisCache;
  /** Current mindbase.config.json (re-read on change); null if the file is missing. */
  readonly config: MCPConfig | null;
  getAdapter: () => LLMAdapter;   // throws if config missing
  reindex: () => Promise<void>;
  /** Identifies the calling client if detectable (from MCP_CLIENT env var). */
  mcpClient: string;
  /**
   * Whether tools may read arbitrary local file paths (mindbase_ingest_file).
   * True for stdio, where the client already runs on this machine; the HTTP
   * transport turns it off because remote clients must not read server files.
   */
  allowLocalFilePaths: boolean;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

const isDir = (p: string) => fs.stat(p).then((st) => st.isDirectory(), () => false);

/**
 * Same store as the web server (LBV2-26 QA): reads and writes go to projects/<currentProjectId>/
 * (config.json, default "default") through ProjectScopedStore, so MCP and web app see the same pages.
 * Only a legacy data dir — wiki/ present, projects/<id>/ absent — keeps the unscoped layout. The
 * decision is re-checked per call until the project directory exists (the web server may scaffold or
 * migrate it after this process started; the MCP server itself never migrates, to avoid racing it).
 */
async function openStore(dataDir: string): Promise<Store> {
  const raw = new FileStore(dataDir);
  const projectId = (await currentProjectId(dataDir)) ?? 'default';
  if (!isValidProjectId(projectId)) throw new Error('config.json currentProjectId is not a valid project id');
  const scoped = new ProjectScopedStore(raw, projectId);
  let settled = false;
  const pick = async (): Promise<Store> => {
    if (settled) return scoped;
    if (await isDir(path.join(dataDir, 'projects', projectId))) { settled = true; return scoped; }
    return (await isDir(path.join(dataDir, 'wiki'))) ? raw : scoped;
  };
  if ((await pick()) === scoped) {
    // Pages an older MCP server wrote to the legacy location are invisible to both servers now.
    try {
      const stray = (await fs.readdir(path.join(dataDir, 'wiki', 'notes'))).filter((f) => f.endsWith('.md')).length;
      if (stray > 0) {
        process.stderr.write(`[mindbase-mcp] warning: ${stray} page(s) in the legacy <dataDir>/wiki/notes are outside project "${projectId}" and not served; move them to projects/${projectId}/wiki/notes to keep them\n`);
      }
    } catch { /* no legacy dir */ }
  }
  return {
    writeText: async (p, c) => (await pick()).writeText(p, c),
    readText: async (p) => (await pick()).readText(p),
    writeJSON: async (p, v) => (await pick()).writeJSON(p, v),
    readJSON: async <T>(p: string) => (await pick()).readJSON<T>(p),
    writeBinary: async (p, d) => (await pick()).writeBinary(p, d),
    readBinary: async (p) => (await pick()).readBinary(p),
    exists: async (p) => (await pick()).exists(p),
    listDir: async (p) => (await pick()).listDir(p),
    remove: async (p) => (await pick()).remove(p),
  };
}

export async function loadContext(opts: {
  dataDir?: string;
  /** Required, no default (fail closed): true only for stdio, false for remote transports. */
  allowLocalFilePaths: boolean;
}): Promise<Context> {
  if (typeof opts.allowLocalFilePaths !== 'boolean') {
    throw new Error('loadContext: allowLocalFilePaths must be set explicitly');
  }
  const dataDir = expandHome(opts.dataDir ?? process.env['MINDBASE_DATA_DIR'] ?? path.join(os.homedir(), 'mindbase-data'));
  await fs.mkdir(dataDir, { recursive: true });

  const store = await openStore(dataDir);
  const feeds = new FeedStore(dataDir);
  const cards = new CardStore(dataDir);
  const templates = new TemplateStore(dataDir);
  await templates.ensureDefaults();
  const synthesisCache = new SynthesisCache(dataDir);

  // Missing config is ok — read-only tools still work. Re-read on change (LBV2-32).
  const configFile = createConfigReloader<MCPConfig>(path.join(dataDir, 'mindbase.config.json'), {
    minIntervalMs: configReloadIntervalMs(process.env),
    log: (line) => { process.stderr.write(line); },
  });
  configFile.current();

  // Build a fresh search index from disk on each start (cheap for personal-scale wikis)
  const searchIndex = new SearchIndex();
  try {
    const entries = await store.listDir('wiki/notes');
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.replace(/\.md$/, '');
      const body = await store.readText(`wiki/notes/${entry.name}`);
      let title = slug;
      try {
        const meta = await store.readJSON<{ title: string }>(`wiki/notes/${slug}.meta.json`);
        title = meta.title;
      } catch { /* keep slug */ }
      searchIndex.add({ path: `wiki/notes/${slug}.md`, title, body, type: 'concept' });
    }
  } catch { /* wiki/notes may not exist yet */ }

  // Open the persistent graph index (shared path with server: <dataDir>/.index/db.sqlite).
  // Empty index → lazy reindex from disk so graph tools work even on first launch.
  const indexDir = path.join(dataDir, '.index');
  await fs.mkdir(indexDir, { recursive: true });
  const wikiIndex = WikiIndex.open(path.join(indexDir, 'db.sqlite'));

  if (wikiIndex.allPages().length === 0) {
    const r = await reindex(store, wikiIndex);
    process.stderr.write(
      `[mindbase-mcp] wiki-index initial reindex — ${r.pagesProcessed} pages, ${r.linksWritten} links, ${r.durationMs}ms\n`,
    );
  }

  return {
    dataDir,
    store,
    wikiIndex,
    searchIndex,
    feeds,
    cards,
    templates,
    synthesisCache,
    get config() { return configFile.current(); },
    getAdapter: () => {
      const config = configFile.current();
      if (!config) throw new Error('LLM not configured');
      return createAdapter(config.provider, {
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl || undefined,
        ruleId: config.ruleId,
        extractPdfText: (data, o) => extractPdfText(new Uint8Array(data), { maxChars: o.maxChars }),
        maxDocumentChars: config.maxContextChars,
      });
    },
    reindex: async () => {
      // Rebuild index from disk
      const fresh = new SearchIndex();
      const entries = await store.listDir('wiki/notes');
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
        const slug = entry.name.replace(/\.md$/, '');
        const body = await store.readText(`wiki/notes/${entry.name}`);
        let title = slug;
        try {
          const meta = await store.readJSON<{ title: string }>(`wiki/notes/${slug}.meta.json`);
          title = meta.title;
        } catch { /* keep slug */ }
        fresh.add({ path: `wiki/notes/${slug}.md`, title, body, type: 'concept' });
      }
      // Replace internal state
      Object.assign(searchIndex, fresh);
    },
    mcpClient: process.env['MCP_CLIENT'] ?? 'unknown',
    allowLocalFilePaths: opts.allowLocalFilePaths,
  };
}

// Helper for resolving paths under a project's v2 layout.
import { join as pathJoin } from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';

export async function currentProjectId(dataDir: string): Promise<string | null> {
  try {
    const cfg = JSON.parse(await fsReadFile(pathJoin(dataDir, 'config.json'), 'utf-8')) as { currentProjectId?: string };
    return cfg.currentProjectId ?? null;
  } catch { return null; }
}

export function projectRoot(dataDir: string, projectId: string): string {
  return pathJoin(dataDir, 'projects', projectId);
}
