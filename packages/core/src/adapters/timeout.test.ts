// @vitest-environment node
// (the DOM test environment's fetch enforces CORS against the fake provider)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIAdapter } from './openai';
import { AnthropicAdapter } from './anthropic';
import { OllamaAdapter } from './ollama';
import { DEFAULT_LLM_TIMEOUT_MS, LLM_TIMEOUT_ERROR, readLlmTimeoutMs } from './timeout';
import type { ChatChunk, ChatMessage } from '../types';
import type { AdapterConfig, LLMAdapter } from './types';

/**
 * Fake provider: `/silent/...` accepts the request and never answers;
 * `/stall/...` sends headers plus one chunk and then goes quiet.
 */
let server: Server;
let base: string;
const open = new Set<ServerResponse>();

beforeAll(async () => {
  server = createServer((req, res) => {
    open.add(res);
    req.resume();
    if (req.url?.startsWith('/stall')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of open) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function collect(adapter: LLMAdapter, messages: ChatMessage[]): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const c of adapter.chat({ model: 'm', messages })) chunks.push(c);
  return chunks;
}

const text: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const pdf: ChatMessage[] = [
  { role: 'user', content: [{ type: 'document', media_type: 'application/pdf', data: 'AAAA' }] },
];

type Make = (cfg: AdapterConfig) => LLMAdapter;
const cases: Array<[string, Make, ChatMessage[]]> = [
  ['openai chat/completions', (c) => new OpenAIAdapter(c), text],
  ['openai responses', (c) => new OpenAIAdapter(c), pdf],
  ['anthropic', (c) => new AnthropicAdapter(c), text],
  ['ollama', (c) => new OllamaAdapter(c), text],
];

describe('LLM provider request timeout (LBV2-14)', () => {
  for (const mode of ['silent', 'stall'] as const) {
    it.each(cases)(`%s gives up on a ${mode} provider with a generic error`, async (_name, make, messages) => {
      const adapter = make({ apiKey: 'k', model: 'm', baseUrl: `${base}/${mode}`, timeoutMs: 200 });
      const started = Date.now();
      const chunks = await collect(adapter, messages);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(chunks.at(-1)).toEqual({ kind: 'error', error: LLM_TIMEOUT_ERROR });
      expect(JSON.stringify(chunks)).not.toContain('127.0.0.1');
    }, 10_000);
  }
});

describe('readLlmTimeoutMs', () => {
  it('defaults to 120000 ms', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(120_000);
    expect(readLlmTimeoutMs({})).toBe(120_000);
    expect(readLlmTimeoutMs({ MINDBASE_LLM_TIMEOUT_MS: '' })).toBe(120_000);
  });

  it('accepts integers between 1000 and 3600000', () => {
    expect(readLlmTimeoutMs({ MINDBASE_LLM_TIMEOUT_MS: '1000' })).toBe(1000);
    expect(readLlmTimeoutMs({ MINDBASE_LLM_TIMEOUT_MS: '3600000' })).toBe(3_600_000);
  });

  it.each(['0', '999', '3600001', '-5', '1.5', 'abc', '10s'])('rejects %s', (v) => {
    expect(() => readLlmTimeoutMs({ MINDBASE_LLM_TIMEOUT_MS: v })).toThrow(/MINDBASE_LLM_TIMEOUT_MS/);
  });

  it('adapters read the env default when no timeoutMs is given', () => {
    const prev = process.env['MINDBASE_LLM_TIMEOUT_MS'];
    process.env['MINDBASE_LLM_TIMEOUT_MS'] = 'nope';
    try {
      expect(() => new OllamaAdapter({ apiKey: '', model: 'm' })).toThrow(/MINDBASE_LLM_TIMEOUT_MS/);
    } finally {
      if (prev === undefined) delete process.env['MINDBASE_LLM_TIMEOUT_MS'];
      else process.env['MINDBASE_LLM_TIMEOUT_MS'] = prev;
    }
  });
});
