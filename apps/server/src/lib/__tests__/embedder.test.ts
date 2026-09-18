import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records whether the in-process model was ever requested; returns a fake extractor.
const loads = vi.hoisted(() => ({ count: 0, tokenizer: { model_max_length: 8192 } }));
vi.mock('@xenova/transformers', () => ({
  env: { allowRemoteModels: true, cacheDir: null },
  pipeline: vi.fn(async () => {
    loads.count += 1;
    return Object.assign(async (text: string) => ({ data: new Float32Array([text.length, 0, 0]) }), { tokenizer: loads.tokenizer });
  }),
}));

const TOKEN = 'embed-token-for-tests-0123456789';

describe('server embedder (LBV2-26)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    loads.count = 0;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the shared service and never loads the model when URL and token are set', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', 'http://embed:8080');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', TOKEN);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ vectors: [[0.6, 0.8, 0]], dim: 3 }), { status: 200 }));
    const { embed, unloadExtractor } = await import('../embedder');
    expect(await embed('hello')).toEqual([0.6, 0.8, 0]);
    unloadExtractor();
    expect(loads.count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://embed:8080/embed');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('surfaces service errors instead of falling back to the in-process model', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', 'http://embed:8080');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', TOKEN);
    vi.stubEnv('MINDBASE_EMBED_RETRIES', '0');
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { embed } = await import('../embedder');
    await expect(embed('private text')).rejects.toThrow(/rejected the vault token/);
    expect(loads.count).toBe(0);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toMatch(/embedding service/);
    expect(logged).not.toContain('private text');
    expect(logged).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it('refuses to start embedding with only one of the two variables set', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', 'http://embed:8080');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', '');
    const { embed } = await import('../embedder');
    await expect(embed('x')).rejects.toThrow(/MINDBASE_EMBED_TOKEN/);
    expect(loads.count).toBe(0);
  });

  it('embeds in-process (same pooling as before) when neither variable is set', async () => {
    vi.stubEnv('MINDBASE_EMBED_URL', '');
    vi.stubEnv('MINDBASE_EMBED_TOKEN', '');
    const { embed } = await import('../embedder');
    expect(await embed('abcd')).toEqual([4, 0, 0]);
    expect(loads.count).toBe(1);
    // Same token cap as the shared service (audit HIGH-2), so vectors stay interchangeable
    expect(loads.tokenizer.model_max_length).toBe(2048);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
