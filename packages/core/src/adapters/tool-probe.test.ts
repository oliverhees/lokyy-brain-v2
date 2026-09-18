import { describe, it, expect } from 'vitest';
import { probeToolCalling, TOOL_PROBE_TOOL } from './tool-probe';
import type { LLMAdapter } from './types';
import type { ChatChunk, ChatRequest } from '../types';

// LBV2-32 C: ingest needs tool calls; the connection test probes for them.

function adapter(chunks: ChatChunk[] | (() => never)): { a: LLMAdapter; reqs: ChatRequest[] } {
  const reqs: ChatRequest[] = [];
  const a = {
    name: 'mock',
    supportsTools: true,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      reqs.push(req);
      if (typeof chunks === 'function') chunks();
      for (const c of chunks as ChatChunk[]) yield c;
    },
  } as unknown as LLMAdapter;
  return { a, reqs };
}

const done: ChatChunk = { kind: 'done', usage: { input_tokens: 1, output_tokens: 1 } };

describe('probeToolCalling', () => {
  it('reports supported when the model calls the probe tool', async () => {
    const { a, reqs } = adapter([
      { kind: 'tool_call', tool_call: { id: 'c1', name: TOOL_PROBE_TOOL.name, arguments: { value: 'ok' } } },
      done,
    ]);
    expect(await probeToolCalling(a, 'm')).toEqual({ status: 'supported' });
    expect(reqs[0]?.tools?.map((t) => t.name)).toEqual([TOOL_PROBE_TOOL.name]);
    expect(reqs[0]?.max_tokens).toBeGreaterThan(0);
    expect(reqs[0]?.max_tokens).toBeLessThanOrEqual(512);
  });

  it('reports unsupported when the model answers with text only', async () => {
    const { a } = adapter([{ kind: 'delta', text: 'ok' }, done]);
    expect(await probeToolCalling(a, 'm')).toEqual({ status: 'unsupported' });
  });

  it('reports unknown (with the error) when the call fails', async () => {
    const { a } = adapter([{ kind: 'error', error: 'HTTP 500: boom' }, done]);
    expect(await probeToolCalling(a, 'm')).toEqual({ status: 'unknown', error: 'HTTP 500: boom' });
  });

  it('reports unknown when the adapter throws', async () => {
    const { a } = adapter(() => { throw new Error('network down'); });
    expect(await probeToolCalling(a, 'm')).toEqual({ status: 'unknown', error: 'network down' });
  });
});
