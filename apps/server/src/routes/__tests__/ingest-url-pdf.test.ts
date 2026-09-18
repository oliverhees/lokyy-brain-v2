import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestRoutes } from '../ingest';
import { createContext } from '../../context';
import { makePdf } from '../../lib/test-helpers/make-pdf';

// LBV2-30 final audit: URL ingest of a PDF goes through the bounded extractor (page cap, timeout).
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pages = Number((req.url ?? '').match(/\/(\d+)\.pdf$/)?.[1] ?? 1);
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(Buffer.from(makePdf(pages)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function ingestUrl(url: string) {
  vi.stubEnv('MINDBASE_ALLOW_PRIVATE_FETCH', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const outer = await mkdtemp(join(tmpdir(), 'ingest-url-pdf-'));
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/ingest', ingestRoutes(await createContext(outer)));
    return await request(app).post('/api/ingest/text').send({ text: url });
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
}

describe('POST /api/ingest/text with a PDF URL', () => {
  it('refuses a PDF with more than 500 pages (default cap)', async () => {
    const res = await ingestUrl(`${base}/501.pdf`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'URL fetch failed: PDF has more than 500 pages' });
  });

  it('honours VAULT_PDF_MAX_PAGES', async () => {
    vi.stubEnv('VAULT_PDF_MAX_PAGES', '2');
    const res = await ingestUrl(`${base}/3.pdf`);
    expect(res.body).toEqual({ ok: false, error: 'URL fetch failed: PDF has more than 2 pages' });
  });

  it('still ingests a normal PDF', async () => {
    const res = await ingestUrl(`${base}/3.pdf`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: 'pdf' });
  });
});
