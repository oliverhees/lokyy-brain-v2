import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext } from '../../context.js';
import { opsRoutes } from '../ops.js';

describe('ops routes — X-Mindbase-User validation (LBV2-11)', () => {
  let outer: string;
  let app: express.Application;

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'ops-user-test-'));
    const dataDir = join(outer, 'data');
    const proj = join(dataDir, 'projects', 'o');
    await mkdir(join(proj, 'sources', 'contributors'), { recursive: true });
    await writeFile(join(proj, 'README.md'), '# o');
    await writeFile(join(proj, 'context.md'), '# ctx');
    await writeFile(join(proj, 'index.yaml'), 'project:\n  id: o\n');
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ currentProjectId: 'o' }));
    const ctx = await createContext(dataDir);
    app = express();
    app.use(express.json());
    app.use('/api/ops', opsRoutes(ctx));
  });

  afterEach(async () => { await rm(outer, { recursive: true, force: true }); });

  it('rejects a traversal username before any op runs', async () => {
    const res = await request(app)
      .post('/api/ops/contribute')
      .set('x-mindbase-user', '../../../../../evil')
      .send({ mode: 'plan', text: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid X-Mindbase-User header' });
  });
});
