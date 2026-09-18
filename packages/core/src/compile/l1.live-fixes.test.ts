import { describe, it, expect, afterEach } from 'vitest';
import { compileL1, compileL1Plan, DEFAULT_COMPILE_MAX_TOKENS, NO_TOOL_CALLS_ERROR } from './l1';
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
      requests.push(req);
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
    const plan = await compileL1Plan({ ...(await base()), adapter });
    expect(plan.proposed).toHaveLength(0);
    expect(plan.error).toBe(NO_TOOL_CALLS_ERROR);
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
