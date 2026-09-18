import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRawDoc } from './notes';

// LBV2-32: text ingested via /api/ingest/text is listed under its raw id with a title.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('getRawDoc', () => {
  it('opens an ingested text source by raw id and shows its title', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(input);
      if (input === '/api/tree/raw') return json({ entries: [{ date: '2026-09-18', id: 'ab12cd', size: 5, kind: 'text', title: 'Basel note' }] });
      return json({ body: 'Basel lies on the Rhine.' });
    }));
    const doc = await getRawDoc('ab12cd');
    expect(calls[1]).toBe('/api/tree/raw/2026-09-18/ab12cd');
    expect(doc).toMatchObject({ id: 'ab12cd', title: 'Basel note', content: 'Basel lies on the Rhine.', has_binary: false });
  });

  it('falls back to the id as title for sources/raw files', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === '/api/tree/raw'
      ? json({ entries: [{ date: '2026-06-09', id: 'doc-1.md', size: 5, kind: 'text' }] })
      : json({ body: '# raw' }))));
    expect((await getRawDoc('doc-1.md')).title).toBe('doc-1.md');
  });
});
