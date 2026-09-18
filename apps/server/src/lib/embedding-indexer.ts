import type { ServerContext } from '../context';
import type { MetaJson } from '@mindbase/core';
import { EmbeddingStore, paths } from '@mindbase/core';
import { embed, unloadExtractor } from './embedder.js';

interface IndexStatus {
  indexed: number;
  total: number;
  current?: string;
}

/**
 * Background worker that maintains a dense embedding index for all wiki pages.
 *
 * - On start(): scans all wiki/notes pages and embeds any with a stale hash.
 * - On indexOne(slug): re-embeds a single page (call after save/compile).
 * - getStatus(): returns live progress for /api/search/index-status.
 *
 * - Sweep (LBV2-26 QA): after the first run, indexAll() repeats every `sweepMs` (default 60 s,
 *   MINDBASE_EMBED_SWEEP_MS, 0 = off). Unchanged pages cost a hash check, no embedding. Pages that
 *   failed (e.g. the embedding service restarted) and pages written by another process (the MCP
 *   server) get embedded without a restart. While a run has failures the interval doubles up to
 *   `maxSweepMs` (default 30 min) and returns to `sweepMs` after a clean run. A page whose text the
 *   service answered with HTTP 500 is skipped until its content changes.
 *
 * NOTE: The BGE-M3 model (~570MB) is loaded lazily on first embed call.
 * indexAll() runs in the background — it does NOT block server boot.
 * After batch indexing, the extractor is unloaded to free ~600MB RAM.
 */
export interface EmbeddingIndexerOptions {
  sweepMs?: number;
  maxSweepMs?: number;
}

/** MINDBASE_EMBED_SWEEP_MS: sweep interval in ms (0 = off), default 60000. */
export function sweepMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env['MINDBASE_EMBED_SWEEP_MS'];
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('MINDBASE_EMBED_SWEEP_MS must be a non-negative integer');
  return n;
}

export class EmbeddingIndexer {
  private status: IndexStatus = { indexed: 0, total: 0 };
  private running = false;
  private loggedOnce = false;
  /** slug → content hash of a text the embedding service failed on (HTTP 500); not resent until it changes. */
  private readonly poisoned = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly sweepMs: number;
  private interval = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly maxSweepMs: number;

  constructor(
    private ctx: ServerContext,
    private store: EmbeddingStore,
    opts: EmbeddingIndexerOptions = {},
  ) {
    this.sweepMs = opts.sweepMs ?? sweepMsFromEnv();
    this.maxSweepMs = Math.max(this.sweepMs, opts.maxSweepMs ?? 30 * 60_000);
  }

  /**
   * Start background indexing. Returns immediately; indexAll runs in background, then sweeps.
   */
  start(): void {
    this.stopped = false;
    this.interval = this.sweepMs;
    this.pending = this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when the current run (first run or sweep) has finished. For tests and shutdown. */
  whenIdle(): Promise<void> {
    return this.pending;
  }

  private async run(): Promise<void> {
    let failed = 1;
    try {
      failed = (await this.indexAll()).failed;
    } catch (e) {
      console.error('[embedding-indexer] indexAll failed:', (e as Error).message);
    }
    if (this.stopped || this.sweepMs <= 0) return;
    let wait = this.sweepMs;
    if (failed > 0) {
      wait = this.interval;
      this.interval = Math.min(this.interval * 2, this.maxSweepMs);
    } else {
      this.interval = this.sweepMs;
    }
    this.timer = setTimeout(() => { this.pending = this.run(); }, wait);
    this.timer.unref?.();
  }

  /**
   * Scan all wiki notes and embed any whose content hash has changed.
   * Runs batches of 5 pages in parallel.
   */
  async indexAll(): Promise<{ indexed: number; skipped: number; failed: number }> {
    if (this.running) return { indexed: 0, skipped: 0, failed: 0 };
    this.running = true;
    try {
      return await this.indexAllOnce();
    } finally {
      this.running = false;
    }
  }

  private async indexAllOnce(): Promise<{ indexed: number; skipped: number; failed: number }> {
    let indexed = 0;
    let skipped = 0;
    let failed = 0;

    const entries = await paths.listAllWikiPages(this.ctx.store);
    const mdFiles = entries.filter(
      (e) => e.kind === 'file' && e.name.endsWith('.md'),
    );
    this.status.total = mdFiles.length;
    this.status.indexed = 0;

    // Process in batches of 5
    const BATCH = 5;
    for (let i = 0; i < mdFiles.length; i += BATCH) {
      const batch = mdFiles.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (entry) => {
          const slug = entry.name.replace(/\.md$/, '');
          this.status.current = slug;
          try {
            const didEmbed = await this.embedIfStale(slug);
            if (didEmbed) indexed++;
            else skipped++;
          } catch (e) {
            console.warn(`[embedding-indexer] failed to embed ${slug}:`, (e as Error).message);
            failed++;
          }
          this.status.indexed++;
        }),
      );
    }

    this.status.current = undefined;

    // Release the ~600MB model from memory after batch indexing completes
    if (indexed > 0) {
      try {
        unloadExtractor();
      } catch { /* ok */ }
    }

    // Sweeps that change nothing stay quiet
    if (indexed > 0 || failed > 0 || !this.loggedOnce) {
      console.log(`[embedding-indexer] done: indexed=${indexed} skipped=${skipped} failed=${failed}`);
      this.loggedOnce = true;
    }
    return { indexed, skipped, failed };
  }

  /**
   * Re-embed a single page by slug. Call after wiki save or capture compile.
   * Fire-and-forget safe; errors are logged but not thrown.
   */
  async indexOne(slug: string): Promise<void> {
    try {
      await this.embedIfStale(slug);
    } catch (e) {
      console.warn(`[embedding-indexer] indexOne(${slug}) failed:`, (e as Error).message);
    }
  }

  /** Returns true if embedding was computed (content was stale), false if skipped. */
  private async embedIfStale(slug: string): Promise<boolean> {
    let title = slug;
    let body = '';

    const located = await paths.findWikiPagePath(
      async (p) => this.ctx.store.exists(p),
      slug,
    );
    if (!located) return false;

    try {
      const meta = await this.ctx.store.readJSON<MetaJson>(located.meta);
      title = meta.title ?? slug;
    } catch { /* ok */ }

    try {
      body = await this.readBodyWithOcr(located.md);
    } catch {
      return false; // no body, nothing to embed
    }

    const content = `${title}\n\n${body}`;
    if (await this.store.hashMatches(slug, content)) {
      return false; // already up to date
    }

    // A text the shared service failed on (HTTP 500: model error, or an inference timeout after which
    // the service restarts) is not resent by every sweep; it is retried once the page changes.
    const hash = EmbeddingStore.contentHash(content);
    if (this.poisoned.get(slug) === hash) return false;
    let vector: number[];
    try {
      vector = await embed(content);
    } catch (e) {
      if ((e as { status?: unknown }).status === 500) this.poisoned.set(slug, hash);
      throw e;
    }
    this.poisoned.delete(slug);
    await this.store.set(slug, content, vector);
    return true;
  }

  getStatus(): IndexStatus {
    return { ...this.status };
  }

  /**
   * Read a wiki page's markdown body (from either layer — caller supplies the
   * resolved md path) and append OCR sidecar text for any embedded attachment
   * images. This lets semantic search match against text that lives inside
   * screenshots/photos rather than the note prose alone.
   */
  private async readBodyWithOcr(mdPath: string): Promise<string> {
    const raw = await this.ctx.store.readText(mdPath);
    const re = /\/api\/wiki\/attachments\/([^/)\s]+)\/([0-9a-f]+\.(?:png|jpg|jpeg|gif|webp))/gi;
    const matches = Array.from(raw.matchAll(re));
    if (matches.length === 0) return raw;
    const blocks: string[] = [];
    for (const m of matches) {
      const slugDir = m[1]!;
      const file = m[2]!;
      try {
        const txt = await this.ctx.store.readText(`attachments/${slugDir}/${file}.ocr.txt`);
        if (txt.trim().length > 0) blocks.push(txt.trim());
      } catch { /* skip */ }
    }
    return blocks.length > 0 ? `${raw}\n\n${blocks.join('\n\n')}` : raw;
  }
}
