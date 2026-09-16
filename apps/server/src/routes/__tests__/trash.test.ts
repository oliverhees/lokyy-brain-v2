import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, writeFile, rm, readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '@mindbase/core';
import { createContext, type ServerContext } from '../../context.js';
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
    // The route serves the trash from ctx.rawStore (the unscoped FileStore).
    store = ctx.rawStore as FileStore;
    app = express();
    app.use(express.json());
    app.use('/api/trash', trashRoutes({ ...ctx, reindexWiki: async () => {} }));
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

describe('trash routes — default project-scoped layout (LBV2-14)', () => {
  let dataDir: string;
  let app: express.Application;
  let ctx: ServerContext;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'trash-default-layout-'));
    ctx = await createContext(dataDir);
    app = express();
    app.use(express.json());
    // The real context: ctx.store is a ProjectScopedStore, not a FileStore.
    app.use('/api/trash', trashRoutes(ctx));
  });

  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  async function trashFile(rel: string, body: string): Promise<string> {
    const raw = ctx.rawStore as FileStore;
    await raw.writeText(rel, body);
    return (await raw.moveToTrash([rel])).id;
  }

  it('GET / lists entries instead of failing with 500', async () => {
    const empty = await request(app).get('/api/trash');
    expect(empty.status).toBe(200);
    expect(empty.body.entries).toEqual([]);

    const id = await trashFile(`projects/${ctx.currentProjectId}/wiki/notes/a.md`, 'A');
    const res = await request(app).get('/api/trash');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual([id]);
  });

  it('restore, permanent delete and empty work', async () => {
    const rel = `projects/${ctx.currentProjectId}/wiki/notes/b.md`;
    const id1 = await trashFile(rel, 'B');
    const r1 = await request(app).post(`/api/trash/restore/${encodeURIComponent(id1)}`);
    expect(r1.status).toBe(200);
    expect(await ctx.store.readText('wiki/notes/b.md')).toBe('B');

    const id2 = await trashFile(rel, 'B');
    expect((await request(app).post(`/api/trash/permanent-delete/${encodeURIComponent(id2)}`)).status).toBe(200);
    expect((await request(app).get('/api/trash')).body.entries).toEqual([]);

    await trashFile(`projects/${ctx.currentProjectId}/wiki/notes/c.md`, 'C');
    expect((await request(app).post('/api/trash/empty')).status).toBe(200);
    expect((await request(app).get('/api/trash')).body.entries).toEqual([]);
  });

  it('keeps LBV2-11 id validation', async () => {
    const res = await request(app).post('/api/trash/permanent-delete/..%2F..');
    expect(res.status).toBe(400);
  });
});
