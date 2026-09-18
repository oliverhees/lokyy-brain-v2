import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { ServerContext } from '../context';
import { fetchUntrusted } from '@mindbase/core';
import type { FeedStore, Feed } from '@mindbase/core';
import type { Inbox } from './inbox';

const parser = new Parser();
const FEED_MAX_BYTES = 5 * 1024 * 1024;

/** The response subset the worker reads; `Response` and `SafeFetchResponse` both satisfy it. */
export interface FeedFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  /** Final URL after redirects, if the fetcher reports it. */
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FeedFetcher = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number; maxBytes?: number },
) => Promise<FeedFetchResponse>;

/** Feed and article URLs come from users and from feed content: SSRF-safe by default (LBV2-13). */
// Failures carry only the generic message (stored as the feed's last_error, visible to clients).
const defaultFetcher: FeedFetcher = (url, init) =>
  fetchUntrusted(url, { ...init, acceptStatus: (s) => (s >= 200 && s < 300) || s === 304 });

interface PollResult {
  ingested: number;
  errors: string[];
}

export class RSSWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private ctx: ServerContext,
    private feeds: FeedStore,
    private inbox: Inbox,
    private intervalMs: number = 60 * 60 * 1000,
    private fetcher: FeedFetcher = defaultFetcher,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one full polling cycle. */
  async tick(): Promise<{
    feeds_polled: number;
    total_ingested: number;
    errors: Array<{ feed: string; error: string }>;
  }> {
    if (this.running) return { feeds_polled: 0, total_ingested: 0, errors: [] };
    this.running = true;
    let feeds_polled = 0;
    let total_ingested = 0;
    const errors: Array<{ feed: string; error: string }> = [];
    try {
      const allFeeds = await this.feeds.list();
      for (const feed of allFeeds) {
        if (!feed.enabled) continue;
        try {
          const r = await this.pollFeed(feed);
          feeds_polled++;
          total_ingested += r.ingested;
          for (const err of r.errors) errors.push({ feed: feed.name, error: err });
        } catch (e) {
          const msg = (e as Error).message;
          await this.feeds.markError(feed.id, msg);
          errors.push({ feed: feed.name, error: msg });
        }
      }
    } finally {
      this.running = false;
    }
    return { feeds_polled, total_ingested, errors };
  }

  /** Poll one feed by id (force, irrespective of enabled flag). */
  async pollOne(id: string): Promise<PollResult> {
    const feed = await this.feeds.findById(id);
    if (!feed) throw new Error('Feed not found');
    return this.pollFeed(feed);
  }

  private async pollFeed(feed: Feed): Promise<PollResult> {
    const headers: Record<string, string> = {
      'User-Agent': this.ctx.config.rss?.fetchUserAgent ?? 'LokyyBrain/0.1',
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

    const timeoutMs = this.ctx.config.rss?.fetchTimeoutMs ?? 15000;
    const res = await this.fetcher(feed.url, { headers, timeoutMs, maxBytes: FEED_MAX_BYTES });

    if (res.status === 304) {
      await this.feeds.markPolled(feed.id, { newGuids: [], ingested: 0 });
      return { ingested: 0, errors: [] };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const body = await res.text();
    const newEtag = res.headers.get('etag') ?? feed.etag;
    const newLastModified = res.headers.get('last-modified') ?? feed.last_modified;

    const parsed = await parser.parseString(body);

    const seen = new Set(feed.seen_guids);
    const addedAt = new Date(feed.added_at).getTime();
    const newGuids: string[] = [];
    const errors: string[] = [];
    let ingested = 0;

    for (const item of parsed.items ?? []) {
      const guid = item.guid ?? item.link ?? `${item.title}-${item.pubDate}`;
      if (!guid || seen.has(guid)) continue;

      // First-add behavior: only ingest if pubDate > added_at
      // (or pubDate missing → conservative skip on first poll)
      const pubMs = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
      const isFirstPoll = feed.seen_guids.length === 0;
      if (isFirstPoll && (Number.isNaN(pubMs) || pubMs <= addedAt)) {
        // Track guid so we don't ingest it next time, but DO NOT ingest
        newGuids.push(guid);
        continue;
      }

      try {
        const text = await this.extractText(item);
        await this.inbox.add({
          type: 'url',
          url: item.link ?? '',
          title: item.title ?? 'Untitled',
          text,
          tags: feed.tags,
          project: feed.project,
          captured_at: item.pubDate
            ? new Date(item.pubDate).toISOString()
            : new Date().toISOString(),
          captured_via: 'rss',
          captured_device_id: `rss-${feed.id}`,
          client_dedup_key: `rss:${feed.id}:${guid}`,
        });
        ingested++;
        newGuids.push(guid);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.toLowerCase().includes('duplicate')) {
          // Already in dedup window; mark seen and skip
          newGuids.push(guid);
        } else {
          errors.push(`${item.title ?? guid}: ${msg}`);
        }
      }
    }

    await this.feeds.markPolled(feed.id, {
      etag: newEtag ?? undefined,
      lastModified: newLastModified ?? undefined,
      newGuids,
      ingested,
    });

    return { ingested, errors };
  }

  /** Extract clean article text via Readability with fallback to RSS snippet. */
  private async extractText(item: {
    link?: string;
    contentSnippet?: string;
    content?: string;
    title?: string;
  }): Promise<string> {
    const readabilityEnabled = this.ctx.config.rss?.readabilityEnabled !== false;
    if (readabilityEnabled && item.link) {
      try {
        const res = await this.fetcher(item.link, {
          headers: {
            'User-Agent': this.ctx.config.rss?.fetchUserAgent ?? 'LokyyBrain/0.1',
          },
          timeoutMs: this.ctx.config.rss?.fetchTimeoutMs ?? 15000,
        });
        if (res.ok) {
          const html = await res.text();
          const dom = new JSDOM(html, { url: res.url || item.link });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          const text = (article?.textContent ?? '').trim();
          if (text.length >= 200) {
            const title = item.title ?? article?.title ?? '';
            return title ? `# ${title}\n\n${text}` : text;
          }
        }
      } catch {
        // Fall through to RSS snippet
      }
    }

    // Fallback to RSS feed's own content
    const fallback =
      item.content && item.content.length > (item.contentSnippet ?? '').length
        ? item.content
        : item.contentSnippet ?? '';

    if (!fallback || fallback.length < 10) {
      throw new Error('No extractable content');
    }
    const title = item.title ?? '';
    return title ? `# ${title}\n\n${fallback}` : fallback;
  }
}
