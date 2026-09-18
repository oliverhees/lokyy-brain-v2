import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_MAX_TOKENS } from './remote-embedder';

const loads = vi.hoisted(() => ({ count: 0, tokenizer: { model_max_length: 8192 } }));
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => {
    loads.count += 1;
    return Object.assign(async (text: string) => ({ data: new Float32Array([text.length, 1]) }), { tokenizer: loads.tokenizer });
  }),
}));

describe('core embed() (LBV2-26)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); loads.count = 0; });

  it('uses the shared embedding service when MINDBASE_EMBED_URL and _TOKEN are set', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', 'http://embed:8080');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', 'core-test-token');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ vectors: [[1, 0]], dim: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { embed } = await import('./embeddings');
    expect(await embed('hi')).toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loads.count).toBe(0);
  });

  it('embeds in-process without them', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', '');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', '');
    const { embed } = await import('./embeddings');
    expect(await embed('abc')).toEqual([3, 1]);
    expect(loads.count).toBe(1);
    expect(loads.tokenizer.model_max_length).toBe(EMBED_MAX_TOKENS);
    expect(EMBED_MAX_TOKENS).toBe(2048);
  });
});
