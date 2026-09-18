import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingStore, MemoryStore } from '@mindbase/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Embedding calls: scripted failures per slug text, then success.
const svc = vi.hoisted(() => ({ failuresLeft: new Map<string, number>(), calls: [] as string[], poison: '' }));
vi.mock('../embedder.js', () => ({
  embed: vi.fn(async (text: string) => {
    svc.calls.push(text);
    if (svc.poison && text.includes(svc.poison)) throw Object.assign(new Error('embedding service refused the request (HTTP 500)'), { status: 500 });
    for (const [marker, n] of svc.failuresLeft) {
      if (text.includes(marker) && n > 0) { svc.failuresLeft.set(marker, n - 1); throw new Error('embedding service unavailable (HTTP 408)'); }
    }
    return [1, 0, 0];
  }),
  unloadExtractor: vi.fn(),
}));

import { EmbeddingIndexer } from '../embedding-indexer';
import type { ServerContext } from '../../context';

async function page(store: MemoryStore, slug: string, body: string): Promise<void> {
  await store.writeText(`wiki/notes/${slug}.md`, body);
  await store.writeJSON(`wiki/notes/${slug}.meta.json`, { title: slug });
}

describe('EmbeddingIndexer sweep (LBV2-26 QA: failed pages are re-indexed)', () => {
  let dir: string;
  let store: MemoryStore;
  let embeddings: EmbeddingStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'mb-indexer-'));
    store = new MemoryStore();
    embeddings = new EmbeddingStore(dir);
    svc.failuresLeft.clear();
    svc.calls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const tick = async (ix: EmbeddingIndexer, ms: number) => { await vi.advanceTimersByTimeAsync(ms); await ix.whenIdle(); };
  const make = () => new EmbeddingIndexer({ store } as unknown as ServerContext, embeddings, { sweepMs: 1_000, maxSweepMs: 8_000 });

  it('a page that failed during the first run is embedded by a later sweep without a restart', async () => {
    await page(store, 'ok-page', 'fine');
    await page(store, 'garten', 'qa26-garten body');
    svc.failuresLeft.set('qa26-garten', 1);
    const ix = make();
    ix.start();
    await tick(ix, 10);
    expect(await embeddings.get('garten')).toBeNull();
    expect(await embeddings.get('ok-page')).not.toBeNull();
    await tick(ix, 1_000);
    expect(await embeddings.get('garten')).not.toBeNull();
    ix.stop();
  });

  it('pages written behind the server\'s back (e.g. by the MCP process) are picked up by the sweep', async () => {
    const ix = make();
    ix.start();
    await tick(ix, 10);
    await page(store, 'from-mcp', 'written by MCP');
    await tick(ix, 1_000);
    expect(await embeddings.get('from-mcp')).not.toBeNull();
    ix.stop();
  });

  it('backs off while embedding keeps failing and returns to the base interval after a success', async () => {
    await page(store, 'down', 'marker-down');
    svc.failuresLeft.set('marker-down', 3); // first run + 2 sweeps fail
    const ix = make();
    ix.start();
    await tick(ix, 10);               // run 1 fails
    await tick(ix, 1_000);            // sweep after 1 s fails → next in 2 s
    const afterTwo = svc.calls.length;
    await tick(ix, 1_500);
    expect(svc.calls.length).toBe(afterTwo);              // not yet (backoff)
    await tick(ix, 600);              // sweep at 2 s fails → next in 4 s
    await tick(ix, 4_000);            // succeeds
    expect(await embeddings.get('down')).not.toBeNull();
    ix.stop();
  });

  it('sweeps skip unchanged pages (no embedding call) and can be disabled with sweepMs 0', async () => {
    await page(store, 'stable', 'same');
    const ix = make();
    ix.start();
    await tick(ix, 10);
    const n = svc.calls.length;
    await tick(ix, 3_000);
    expect(svc.calls.length).toBe(n);
    ix.stop();
    const off = new EmbeddingIndexer({ store } as unknown as ServerContext, embeddings, { sweepMs: 0 });
    await page(store, 'late', 'late page');
    off.start();
    await tick(off, 10);
    const m = svc.calls.length;
    await page(store, 'later', 'later page');
    await tick(off, 120_000);
    expect(svc.calls.length).toBe(m);
    off.stop();
  });
});

describe('EmbeddingIndexer: a text the service fails on (HTTP 500) is not resent until it changes', () => {
  let dir: string;
  let store: MemoryStore;
  let embeddings: EmbeddingStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'mb-indexer-'));
    store = new MemoryStore();
    embeddings = new EmbeddingStore(dir);
    svc.failuresLeft.clear();
    svc.poison = 'poison-text';
    svc.calls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    svc.poison = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips the poison page in later sweeps, and retries it once its content changed', async () => {
    await page(store, 'bad', 'contains poison-text');
    const ix = new EmbeddingIndexer({ store } as unknown as ServerContext, embeddings, { sweepMs: 1_000, maxSweepMs: 1_000 });
    ix.start();
    await vi.advanceTimersByTimeAsync(10); await ix.whenIdle();
    const count = () => svc.calls.filter((c) => c.includes('poison-text')).length;
    expect(count()).toBe(1);
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(1_000); await ix.whenIdle(); }
    expect(count()).toBe(1); // not resent: each resend could restart the shared service
    await page(store, 'bad', 'fixed text now');
    await vi.advanceTimersByTimeAsync(1_000); await ix.whenIdle();
    expect(await embeddings.get('bad')).not.toBeNull();
    ix.stop();
  });
});
