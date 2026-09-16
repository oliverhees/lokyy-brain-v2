import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeedStore } from '@mindbase/core';
import { feedsRoutes } from './feeds';
import { ingestRoutes } from './ingest';
import { extractArticleText } from '../lib/article-extract';
import type { ServerContext } from '../context';
import type { RSSWorker } from '../lib/rss-worker';

// A server on loopback stands in for an internal service (metadata endpoint, admin UI, ...).
let internal: Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  delete process.env['MINDBASE_ALLOW_PRIVATE_FETCH'];
  internal = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>internal</title></head><body><article>${'INTERNAL-SECRET '.repeat(50)}</article></body></html>`);
  });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => internal.close(() => r()));
});

describe('server-side URL fetches reject private targets (LBV2-13)', () => {
  it('POST /api/feeds does not probe an internal URL', async () => {
    const added: unknown[] = [];
    const feeds = { add: async (f: unknown) => { added.push(f); return f; } } as unknown as FeedStore;
    const app = express();
    app.use(express.json());
    app.use('/api/feeds', feedsRoutes({} as ServerContext, feeds, {} as RSSWorker));
    const res = await request(app).post('/api/feeds').send({ url: `${base}/feed.xml` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
    expect(added).toHaveLength(0);
    expect(hits).toBe(0);
  });

  it('POST /api/ingest/text does not fetch an internal URL', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/ingest', ingestRoutes({} as ServerContext));
    const res = await request(app).post('/api/ingest/text').send({ text: `${base}/page` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL-SECRET');
    expect(hits).toBe(0);
  });

  it('extractArticleText refuses an internal URL', async () => {
    await expect(extractArticleText(`${base}/article`)).rejects.toThrow(/blocked/i);
    expect(hits).toBe(0);
  });
});
