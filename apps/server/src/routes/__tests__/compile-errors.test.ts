import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NO_TOOL_CALLS_ERROR, type LLMAdapter, type RawDoc } from '@mindbase/core';
import { createContext, type ServerContext } from '../../context.js';
import { compileRoutes } from '../compile.js';
import { compileStreamRoutes } from '../compile-stream.js';

// Keep the local embedding model out of the test (compile's recall step embeds the source).
vi.mock('../../lib/embedder.js', () => ({ embed: async () => new Array(1024).fill(0) }));

// LBV2-32 B: compile failures must reach the client as errors, not as an
// HTTP 200 "ok:false" or an SSE `done` that the UI renders as an empty plan.

const RAW: RawDoc = {
  id: 'raw1',
  path: 'raw/2026-09-18/raw1',
  title: 'Short note',
  content: 'The Rhine flows through Basel.',
  source_url: null,
  captured_at: new Date().toISOString(),
  images: [],
} as unknown as RawDoc;

function adapterFrom(chunks: unknown[]): LLMAdapter {
  return {
    name: 'mock',
    supportsTools: true,
    async *chat() { for (const c of chunks) yield c; },
  } as unknown as LLMAdapter;
}

const textOnly = adapterFrom([
  { kind: 'delta', text: 'A summary without any tool call.' },
  { kind: 'done', usage: { input_tokens: 1, output_tokens: 1 } },
]);
const upstream400 = adapterFrom([
  { kind: 'error', error: 'HTTP 400: estimated tokens exceed context' },
  { kind: 'done', usage: { input_tokens: 0, output_tokens: 0 } },
]);

function sseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const lines = chunk.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) as Record<string, unknown>,
    };
  });
}

describe('compile error propagation (LBV2-32)', () => {
  let outer: string;
  let ctx: ServerContext;
  let app: express.Application;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    outer = await mkdtemp(join(tmpdir(), 'compile-errors-test-'));
    const dataDir = join(outer, 'data');
    await mkdir(dataDir, { recursive: true });
    ctx = await createContext(dataDir);
    ctx.findRawDoc = async (id: string) => (id === RAW.id ? RAW : null);
    app = express();
    app.use(express.json());
    app.use('/api/compile', compileRoutes(ctx));
    app.use('/api/compile', compileStreamRoutes(ctx));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outer, { recursive: true, force: true });
  });

  it('POST /api/compile/:rawId answers 502 with the error when the LLM call fails', async () => {
    ctx.getAdapter = () => upstream400;
    const res = await request(app).post(`/api/compile/${RAW.id}`).send({});
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'HTTP 400: estimated tokens exceed context' });
  });

  it('POST /api/compile/:rawId answers 502 with the tool-call error for text-only models', async () => {
    ctx.getAdapter = () => textOnly;
    const res = await request(app).post(`/api/compile/${RAW.id}`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(NO_TOOL_CALLS_ERROR);
  });

  it('plan stream emits an `error` event (not `done`) when planning fails', async () => {
    ctx.getAdapter = () => upstream400;
    const res = await request(app).post(`/api/compile/${RAW.id}/plan`).buffer(true).parse((r, cb) => {
      let body = '';
      r.on('data', (c: Buffer) => { body += c.toString(); });
      r.on('end', () => cb(null, body));
    });
    const events = sseEvents(res.body as string);
    expect(events.map((e) => e.event)).not.toContain('done');
    const err = events.find((e) => e.event === 'error');
    expect(err?.data['error']).toBe('HTTP 400: estimated tokens exceed context');
  });

  it('plan stream surfaces the no-tool-calls error', async () => {
    ctx.getAdapter = () => textOnly;
    const res = await request(app).post(`/api/compile/${RAW.id}/plan`).buffer(true).parse((r, cb) => {
      let body = '';
      r.on('data', (c: Buffer) => { body += c.toString(); });
      r.on('end', () => cb(null, body));
    });
    const events = sseEvents(res.body as string);
    expect(events.find((e) => e.event === 'error')?.data['error']).toBe(NO_TOOL_CALLS_ERROR);
    expect(events.map((e) => e.event)).not.toContain('done');
  });
});
