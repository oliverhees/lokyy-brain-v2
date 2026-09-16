import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext } from '../../../context.js';
import { treeRoutes } from '../index.js';

describe('tree raw routes', () => {
  let dataDir: string;
  let app: express.Application;
  beforeEach(async () => {
    dataDir = join(tmpdir(), `tree-raw-test-${Date.now()}`);
    const proj = join(dataDir, 'projects', 'r');
    await mkdir(join(proj, 'sources', 'raw', '2026-06-09'), { recursive: true });
    await writeFile(join(proj, 'sources', 'raw', '2026-06-09', 'doc-1.md'), '# raw');
    await writeFile(join(proj, 'README.md'), '# r');
    await writeFile(join(proj, 'context.md'), '# c');
    await writeFile(join(proj, 'index.yaml'), 'project:\n  id: r\n');
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ currentProjectId: 'r' }));
    const ctx = await createContext(dataDir);
    app = express();
    app.use(express.json());
    app.use('/api/tree', treeRoutes(ctx));
  });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('GET /raw returns entries', async () => {
    const res = await request(app).get('/api/tree/raw');
    expect(res.status).toBe(200);
    expect(res.body.entries.some((e: { date: string }) => e.date === '2026-06-09')).toBe(true);
  });

  it('GET /raw/:date/:id returns body', async () => {
    const res = await request(app).get('/api/tree/raw/2026-06-09/doc-1.md');
    expect(res.status).toBe(200);
    expect(res.body.body).toContain('# raw');
  });

  it('GET /raw/:date/:id/binary streams the file', async () => {
    const res = await request(app).get('/api/tree/raw/2026-06-09/doc-1.md/binary').buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => { data += c.toString(); });
      r.on('end', () => cb(null, data));
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('# raw');
  });

  describe('path traversal (LBV2-11)', () => {
    // sources/raw/<date> → dataDir is 4 levels up, dataDir's parent is 5.
    const secretRel = 'raw-trav-secret.txt';
    const secretAbs = () => join(dataDir, '..', secretRel);
    beforeEach(async () => { await writeFile(secretAbs(), 'RAW-CANARY'); });
    afterEach(async () => { await rm(secretAbs(), { force: true }); });

    it.each([
      ['..%2F..%2F..%2F..%2F..', secretRel],
      ['2026-06-09', `..%2F..%2F..%2F..%2F..%2F..%2F${secretRel}`],
      ['2026-06-09', '..%2F2026-06-09%2Fdoc-1.md'],
      ['2026-06-09%2F..', 'doc-1.md'],
      ['not-a-date', 'doc-1.md'],
    ])('GET /raw/%s/%s is rejected', async (date, id) => {
      const res = await request(app).get(`/api/tree/raw/${date}/${id}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('RAW-CANARY');
    });

    it.each([
      ['..%2F..%2F..%2F..%2F..', secretRel],
      ['2026-06-09', `..%2F..%2F..%2F..%2F..%2F..%2F${secretRel}`],
    ])('GET /raw/%s/%s/binary is rejected', async (date, id) => {
      const res = await request(app).get(`/api/tree/raw/${date}/${id}/binary`).buffer(true).parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => { data += c.toString(); });
        r.on('end', () => cb(null, data));
      });
      expect(res.status).toBe(400);
      expect(String(res.body)).not.toContain('RAW-CANARY');
    });
  });
});
