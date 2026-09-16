import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, writeFile, rm, readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '@mindbase/core';
import { createContext } from '../../context.js';
import { trashRoutes } from '../trash.js';

describe('trash routes — path traversal (LBV2-11)', () => {
  let outer: string;
  let dataDir: string;
  let app: express.Application;
  let store: FileStore;

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'trash-route-test-'));
    dataDir = join(outer, 'data');
    await mkdir(join(dataDir, '.trash'), { recursive: true });
    await mkdir(join(outer, 'victim'), { recursive: true });
    await writeFile(join(outer, 'victim', 'keep.txt'), 'precious');
    const ctx = await createContext(dataDir);
    // The route casts ctx.store to FileStore; inject a real one so the trash
    // methods are reachable (the context's ProjectScopedStore has none).
    store = new FileStore(dataDir);
    app = express();
    app.use(express.json());
    app.use('/api/trash', trashRoutes({ ...ctx, store, reindexWiki: async () => {} }));
  });

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); });

  it.each(['..%2F..%2Fvictim', '..%2F..', 'x%2F..%2F..'])('POST /permanent-delete/%s is rejected and deletes nothing', async (id) => {
    const res = await request(app).post(`/api/trash/permanent-delete/${id}`);
    expect(res.status).toBe(400);
    expect(await readFile(join(outer, 'victim', 'keep.txt'), 'utf-8')).toBe('precious');
    expect(JSON.stringify(res.body)).not.toContain(outer);
  });

  it.each(['..%2F..%2Fvictim', '..%2F..'])('POST /restore/%s is rejected', async (id) => {
    const res = await request(app).post(`/api/trash/restore/${id}`);
    expect(res.status).toBe(400);
    expect(await readFile(join(outer, 'victim', 'keep.txt'), 'utf-8')).toBe('precious');
    expect(JSON.stringify(res.body)).not.toContain(outer);
  });

  it('unknown but well-formed id returns 404 without paths', async () => {
    const res = await request(app).post('/api/trash/permanent-delete/2026-09-16T12-00-00-000Z-abcde');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(outer);
  });

  it('crafted manifest on restore returns 400 without paths', async () => {
    await store.writeText('wiki/notes/a.md', 'A');
    const entry = await store.moveToTrash(['wiki/notes/a.md']);
    await writeFile(
      join(dataDir, '.trash', entry.id, 'manifest.json'),
      JSON.stringify({ ...entry, files: [{ originalPath: '../../../victim/keep.txt' }] }),
    );
    const res = await request(app).post(`/api/trash/restore/${entry.id}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(outer);
  });

  it('valid restore and permanent delete still work', async () => {
    await store.writeText('wiki/notes/b.md', 'B');
    const e1 = await store.moveToTrash(['wiki/notes/b.md']);
    const r1 = await request(app).post(`/api/trash/restore/${encodeURIComponent(e1.id)}`);
    expect(r1.status).toBe(200);
    expect(r1.body.restored).toEqual(['wiki/notes/b.md']);

    const e2 = await store.moveToTrash(['wiki/notes/b.md']);
    const r2 = await request(app).post(`/api/trash/permanent-delete/${encodeURIComponent(e2.id)}`);
    expect(r2.status).toBe(200);
  });
});
