import { describe, it, expect, afterEach, vi } from 'vitest';
import { compileL1, compileL1Plan, DEFAULT_COMPILE_MAX_TOKENS, DEFAULT_COMPILE_RETRY_DELAY_MS, NO_TOOL_CALLS_ERROR, TOOL_CALL_NUDGE, isRetryableCompileError, MAX_COMPILE_RETRIES } from './l1';
import { MemoryStore } from '../storage/memory_store';
import { WikiIndex } from '../graph/index/wiki-index';
import type { LLMAdapter } from '../adapters/types';
import type { ChatChunk, ChatRequest, RawDoc } from '../types';
import type { HybridResult } from '../search/hybrid';

// LBV2-32: live E2E against EUrouter found (A) compile sends no max_tokens,
// so providers reject the request, and (C) routes whose models ignore tools
// make compile "succeed" while writing nothing.

function recordingAdapter(scripts: ChatChunk[][]): { adapter: LLMAdapter; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const adapter = {
    name: 'mock',
    supportsTools: true,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push({ ...req, messages: [...req.messages] }); // snapshot: the loop keeps appending
      const script = scripts[turn++] ?? [{ kind: 'done', usage: { input_tokens: 0, output_tokens: 0 } }];
      for (const chunk of script) yield chunk;
    },
  } as unknown as LLMAdapter;
  return { adapter, requests };
}

const textOnly: ChatChunk[] = [
  { kind: 'delta', text: 'Here is a summary of the source, but I will not call any tool.' },
  { kind: 'done', usage: { input_tokens: 10, output_tokens: 5 } },
];
const skipCall: ChatChunk[] = [
  { kind: 'tool_call', tool_call: { id: 's1', name: 'skip', arguments: { reason: 'empty' } } },
  { kind: 'done', usage: { input_tokens: 10, output_tokens: 5 } },
];

const raw = {
  id: 'raw-1',
  path: 'raw/2026-09-18/raw-1',
  title: 'Short note',
  content: 'The Rhine flows through Basel.',
  source_url: null,
  captured_at: new Date().toISOString(),
  images: [],
} as unknown as RawDoc;

const emptyHybrid = async (): Promise<HybridResult[]> => [];

async function base() {
  const store = new MemoryStore();
  await store.writeText('wiki/INDEX.md', '');
  return { raw, store, model: 'm', wikiIndex: WikiIndex.openInMemory(), hybridSearch: emptyHybrid };
}

afterEach(() => {
  delete process.env['MINDBASE_COMPILE_MAX_TOKENS'];
});

describe('compile max_tokens (LBV2-32 A)', () => {
  it('compileL1 sends a default max_tokens when none is configured', async () => {
    const { adapter, requests } = recordingAdapter([skipCall, textOnly]);
    await compileL1({ ...(await base()), adapter });
    expect(DEFAULT_COMPILE_MAX_TOKENS).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.max_tokens).toBe(DEFAULT_COMPILE_MAX_TOKENS);
  });

  it('compileL1Plan sends a default max_tokens when none is configured', async () => {
    const { adapter, requests } = recordingAdapter([skipCall, textOnly]);
    await compileL1Plan({ ...(await base()), adapter });
    for (const r of requests) expect(r.max_tokens).toBe(DEFAULT_COMPILE_MAX_TOKENS);
  });

  it('MINDBASE_COMPILE_MAX_TOKENS overrides the default', async () => {
    process.env['MINDBASE_COMPILE_MAX_TOKENS'] = '1234';
    const { adapter, requests } = recordingAdapter([skipCall, textOnly]);
    await compileL1Plan({ ...(await base()), adapter });
    expect(requests[0]?.max_tokens).toBe(1234);
  });

  it('invalid MINDBASE_COMPILE_MAX_TOKENS falls back to the default', async () => {
    process.env['MINDBASE_COMPILE_MAX_TOKENS'] = 'lots';
    const { adapter, requests } = recordingAdapter([skipCall, textOnly]);
    await compileL1({ ...(await base()), adapter });
    expect(requests[0]?.max_tokens).toBe(DEFAULT_COMPILE_MAX_TOKENS);
  });

  it('explicit max_tokens_per_call wins over env and default', async () => {
    process.env['MINDBASE_COMPILE_MAX_TOKENS'] = '1234';
    const { adapter, requests } = recordingAdapter([skipCall, textOnly]);
    await compileL1({ ...(await base()), adapter, max_tokens_per_call: 777 });
    expect(requests[0]?.max_tokens).toBe(777);
  });
});

describe('compile without tool calls (LBV2-32 C)', () => {
  it('compileL1 fails with a clear error when the model never calls a tool', async () => {
    const { adapter } = recordingAdapter([textOnly]);
    const result = await compileL1({ ...(await base()), adapter });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(NO_TOOL_CALLS_ERROR);
    expect(NO_TOOL_CALLS_ERROR).toMatch(/tool calls/i);
  });

  it('compileL1Plan reports the same error instead of an empty plan', async () => {
    const { adapter } = recordingAdapter([textOnly]);
    const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(plan.proposed).toHaveLength(0);
    expect(plan.error).toBe(NO_TOOL_CALLS_ERROR);
  });

  it('nudges once when the first turn is only the takeaways narrative (plan)', async () => {
    const { adapter, requests } = recordingAdapter([textOnly, skipCall, textOnly]);
    const plan = await compileL1Plan({ ...(await base()), adapter });
    expect(plan.error).toBeUndefined();
    expect(plan.proposed.map((p) => p.call.name)).toEqual(['skip']);
    expect(plan.takeaways).toContain('Here is a summary of the source');
    const second = requests[1]!.messages;
    expect(second[second.length - 2]).toMatchObject({ role: 'assistant' });
    expect(second[second.length - 1]).toEqual({ role: 'user', content: TOOL_CALL_NUDGE });
  });

  it('nudges once when the first turn is only the takeaways narrative (direct compile)', async () => {
    const { adapter, requests } = recordingAdapter([textOnly, skipCall, textOnly]);
    const result = await compileL1({ ...(await base()), adapter });
    expect(result.ok).toBe(true);
    expect(result.tool_results.map((t) => t.call.name)).toEqual(['skip']);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: TOOL_CALL_NUDGE });
  });

  it('fails after the nudge if the model still answers in text only', async () => {
    const { adapter, requests } = recordingAdapter([textOnly, textOnly, skipCall]);
    const plan = await compileL1Plan({ ...(await base()), adapter, retries: 0 });
    expect(plan.error).toBe(NO_TOOL_CALLS_ERROR);
    expect(requests).toHaveLength(2);
    const result = await compileL1({ ...(await base()), adapter: recordingAdapter([textOnly, textOnly, skipCall]).adapter });
    expect(result.error).toBe(NO_TOOL_CALLS_ERROR);
  });

  it('a text-only final turn after tool calls is still a normal finish', async () => {
    const { adapter } = recordingAdapter([skipCall, textOnly]);
    const result = await compileL1({ ...(await base()), adapter });
    expect(result.ok).toBe(true);
    const plan = await compileL1Plan({ ...(await base()), adapter: recordingAdapter([skipCall, textOnly]).adapter });
    expect(plan.error).toBeUndefined();
    expect(plan.proposed).toHaveLength(1);
  });
});

describe('plan retry (LBV2-32 QA: flaky multi-provider routes)', () => {
  const errorTurn = (error: string): ChatChunk[] => [{ kind: 'error', error }, { kind: 'done', usage: { input_tokens: 0, output_tokens: 0 } }];

  it('retries the whole plan once after NO_TOOL_CALLS (text-only even after the nudge)', async () => {
    const { adapter, requests } = recordingAdapter([textOnly, textOnly, skipCall, textOnly]);
    const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(plan.error).toBeUndefined();
    expect(plan.proposed.map((p) => p.call.name)).toEqual(['skip']);
    // Second attempt starts from a fresh conversation (no nudge, no earlier turns).
    expect(requests[2]!.messages.some((m) => m.content === TOOL_CALL_NUDGE)).toBe(false);
  });

  it.each(['HTTP 503: no provider', 'HTTP 429: slow down', 'HTTP 502: bad gateway', 'LLM provider did not respond in time', 'fetch failed'])(
    'retries after a transient provider error: %s', async (error) => {
      const { adapter } = recordingAdapter([errorTurn(error), skipCall, textOnly]);
      const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
      expect(plan.error).toBeUndefined();
      expect(plan.proposed).toHaveLength(1);
    });

  it('does not retry a request the provider rejected (HTTP 400/401)', async () => {
    for (const error of ['HTTP 400: estimated tokens exceed context', 'HTTP 401: bad key']) {
      const { adapter, requests } = recordingAdapter([errorTurn(error), skipCall]);
      const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
      expect(plan.error).toBe(error);
      expect(requests).toHaveLength(1);
    }
  });

  it('gives up after one retry and reports the last error', async () => {
    const { adapter, requests } = recordingAdapter([errorTurn('HTTP 503: a'), errorTurn('HTTP 503: b'), skipCall]);
    const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(plan.error).toBe('HTTP 503: b');
    expect(requests).toHaveLength(2);
  });

  it('retries: 0 disables the retry; the default waits a backoff before retrying', async () => {
    const off = recordingAdapter([errorTurn('HTTP 503: a'), skipCall]);
    expect((await compileL1Plan({ ...(await base()), adapter: off.adapter, retries: 0 })).error).toBe('HTTP 503: a');
    expect(DEFAULT_COMPILE_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(isRetryableCompileError(NO_TOOL_CALLS_ERROR)).toBe(true);
    expect(isRetryableCompileError('HTTP 404: rule not found')).toBe(false);
  });

  it('usage adds up across attempts', async () => {
    const { adapter } = recordingAdapter([textOnly, textOnly, skipCall, textOnly]);
    const plan = await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(plan.total_usage.input_tokens).toBe(40);
  });
});

describe('plan retry limits and logging (LBV2-32 audit/QA)', () => {
  const errorTurn = (error: string): ChatChunk[] => [{ kind: 'error', error }, { kind: 'done', usage: { input_tokens: 0, output_tokens: 0 } }];
  afterEach(() => { delete process.env['MINDBASE_COMPILE_RETRIES']; vi.restoreAllMocks(); });

  it('caps MINDBASE_COMPILE_RETRIES at MAX_COMPILE_RETRIES and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env['MINDBASE_COMPILE_RETRIES'] = '50';
    const { adapter, requests } = recordingAdapter(Array.from({ length: 10 }, () => errorTurn('HTTP 503: x')));
    await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(MAX_COMPILE_RETRIES).toBe(3);
    expect(requests).toHaveLength(1 + MAX_COMPILE_RETRIES);
    expect(warn.mock.calls.some(([m]) => /MINDBASE_COMPILE_RETRIES/.test(String(m)))).toBe(true);
  });

  it('invalid MINDBASE_COMPILE_RETRIES uses the default (1) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env['MINDBASE_COMPILE_RETRIES'] = 'many';
    const { adapter, requests } = recordingAdapter([errorTurn('HTTP 503: x'), errorTurn('HTTP 503: y'), skipCall]);
    await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0 });
    expect(requests).toHaveLength(2);
    expect(warn.mock.calls.some(([m]) => /MINDBASE_COMPILE_RETRIES/.test(String(m)))).toBe(true);
  });

  it('an explicit retries option is capped too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, requests } = recordingAdapter(Array.from({ length: 10 }, () => errorTurn('HTTP 503: x')));
    await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0, retries: 9 });
    expect(requests).toHaveLength(1 + MAX_COMPILE_RETRIES);
  });

  it('logs one line per retry with attempt, limit and a short reason (no provider body)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter } = recordingAdapter([errorTurn('HTTP 503: PROVIDERBODY'), textOnly, textOnly, skipCall, textOnly]);
    await compileL1Plan({ ...(await base()), adapter, retryDelayMs: 0, retries: 2 });
    const lines = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('[compile] retry'));
    expect(lines).toEqual(['[compile] retry 1/2 HTTP 503', '[compile] retry 2/2 no tool calls']);
  });
});
