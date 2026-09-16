import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext } from '../../../context.js';
import { treeRoutes } from '../index.js';

describe('tree template route', () => {
  let outer: string;
  let app: express.Application;
  const savedRoot = process.env['MINDBASE_PLUGIN_ROOT'];

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'tree-template-test-'));
    const dataDir = join(outer, 'data');
    const proj = join(dataDir, 'projects', 't');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'README.md'), '# t');
    await writeFile(join(proj, 'context.md'), '# c');
    await writeFile(join(proj, 'index.yaml'), 'project:\n  id: t\n');
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ currentProjectId: 't' }));
    process.env['MINDBASE_PLUGIN_ROOT'] = join(outer, 'no-plugin-here');
    const ctx = await createContext(dataDir);
    app = express();
    app.use(express.json());
    app.use('/api/tree', treeRoutes(ctx));
  });

  afterEach(async () => {
    if (savedRoot === undefined) delete process.env['MINDBASE_PLUGIN_ROOT'];
    else process.env['MINDBASE_PLUGIN_ROOT'] = savedRoot;
    await rm(outer, { recursive: true, force: true });
  });

  it('missing template returns 500 without leaking the absolute template path', async () => {
    const res = await request(app).post('/api/tree/template/investigation');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(outer);
  });
});
