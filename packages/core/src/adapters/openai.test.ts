import { describe, it, expect, vi } from 'vitest';
import { OpenAIAdapter } from './openai';
import type { ChatChunk } from '../types';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('OpenAIAdapter', () => {
  it('streams text deltas from SSE', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const chunks: ChatChunk[] = [];
    for await (const c of adapter.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c);
    }

    const deltas = chunks.filter((c) => c.kind === 'delta').map((c) => (c as { text: string }).text);
    expect(deltas.join('')).toBe('Hello world');
    const done = chunks.find((c) => c.kind === 'done') as { kind: 'done'; usage: { input_tokens: number; output_tokens: number } } | undefined;
    expect(done).toBeDefined();
    expect(done?.usage.input_tokens).toBe(5);
    expect(done?.usage.output_tokens).toBe(2);
  });

  it('reassembles a data line split across reader chunks', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse([
        // The SSE line `data: {"choices":[{"delta":{"content":"Hi"}}]}` is split here:
        'data: {"choices":[{"delta":',
        '{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c);
    }
    const text = chunks.filter((c) => c.kind === 'delta').map((c) => (c as { text: string }).text).join('');
    expect(text).toBe('Hi');
  });

  it('yields tool_call chunks when present', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"add","arguments":"{\\"a\\":1"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"b\\":2}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const chunks: ChatChunk[] = [];
    for await (const c of adapter.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'what is 1+2' }],
      tools: [
        {
          name: 'add',
          description: 'add two numbers',
          parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
        },
      ],
    })) {
      chunks.push(c);
    }

    const tool = chunks.find((c) => c.kind === 'tool_call');
    expect(tool).toBeDefined();
    if (tool?.kind === 'tool_call') {
      expect(tool.tool_call.name).toBe('add');
      expect(tool.tool_call.arguments).toEqual({ a: 1, b: 2 });
    }
  });

  it('yields error chunk on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-bad',
      model: 'gpt-4o-mini',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.chat({ model: 'gpt-4o-mini', messages: [] })) {
      chunks.push(c);
    }
    expect(chunks[0]?.kind).toBe('error');
  });

  it('testConnection hits /v1/models and returns ok on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('estimateTokens is a rough length/4 heuristic', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'x', model: 'gpt-4o-mini' });
    expect(adapter.estimateTokens('abcd'.repeat(10))).toBeGreaterThan(0);
  });

  it('routes ContentBlock[] with document to Responses API', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
          c.enqueue(enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n'));
          c.close();
        },
      }),
    } as unknown as Response));

    const adapter = new OpenAIAdapter({
      apiKey: 'x',
      model: 'gpt-4o',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const chunks: unknown[] = [];
    for await (const c of adapter.chat({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Read this' },
          { type: 'document', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
        ],
      }],
    })) {
      chunks.push(c);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/v1/responses');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'Read this' },
      { type: 'input_file', filename: 'document.pdf', file_data: expect.stringContaining('data:application/pdf;base64,JVBERi0xLjQK') },
    ]);
    expect(chunks.some((c) => (c as { kind: string; text?: string }).kind === 'delta' && (c as { text: string }).text === 'hi')).toBe(true);
    const done = chunks.find((c) => (c as { kind: string }).kind === 'done') as { kind: 'done'; usage: { input_tokens: number; output_tokens: number } } | undefined;
    expect(done?.usage.input_tokens).toBe(10);
    expect(done?.usage.output_tokens).toBe(2);
  });

  it('routes string content to chat/completions (no regression)', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
          c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    } as unknown as Response));

    const adapter = new OpenAIAdapter({ apiKey: 'x', model: 'gpt-4o', fetchImpl: fetchMock as unknown as typeof fetch });
    const chunks: unknown[] = [];
    for await (const c of adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'plain' }] })) {
      chunks.push(c);
    }

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/v1/chat/completions');
    expect(chunks.some((c) => (c as { kind: string; text?: string }).kind === 'delta' && (c as { text: string }).text === 'hi')).toBe(true);
  });
});

describe('OpenAIAdapter — EUrouter routing rules (LBV2-30)', () => {
  const EU = 'https://api.eurouter.ai/api/v1';
  const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
  const done = () => sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  async function sentBody(cfg: { baseUrl?: string; ruleId?: string; model?: string }, requestModel = 'qwen3.6-27b') {
    const fetchImpl = vi.fn().mockResolvedValue(done());
    const adapter = new OpenAIAdapter({ apiKey: 'eur_k', model: cfg.model ?? 'qwen3.6-27b', baseUrl: cfg.baseUrl, ruleId: cfg.ruleId, fetchImpl: fetchImpl as unknown as typeof fetch });
    for await (const _c of adapter.chat({ model: requestModel, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    return JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it('sends rule_id next to model when a rule is configured', async () => {
    const body = await sentBody({ baseUrl: EU, ruleId: RULE });
    expect(body['rule_id']).toBe(RULE);
    expect(body['model']).toBe('qwen3.6-27b');
  });

  it('keeps model in the body with a rule (EUrouter requires it; the rule filters providers)', async () => {
    const body = await sentBody({ baseUrl: EU, ruleId: RULE, model: '' }, '');
    expect(body['rule_id']).toBe(RULE);
    expect('model' in body).toBe(true);
  });

  it('sends no rule_id without a configured rule', async () => {
    expect('rule_id' in (await sentBody({ baseUrl: EU }))).toBe(false);
  });

  it('never sends rule_id to a non-EUrouter host', async () => {
    expect('rule_id' in (await sentBody({ baseUrl: 'https://api.openai.com', ruleId: RULE }))).toBe(false);
  });

  it('rejects a rule id that is not a UUID', () => {
    expect(() => new OpenAIAdapter({ apiKey: 'k', model: 'm', baseUrl: EU, ruleId: 'my-rule' })).toThrow('Invalid EUrouter rule id');
  });

  it('testConnection on EUrouter validates the key via /routing-rules, not the public /models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }));
    const adapter = new OpenAIAdapter({ apiKey: 'eur_k', model: 'm', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await adapter.testConnection()).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${EU}/routing-rules`);
  });

  it('testConnection on EUrouter fails for a wrong key', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      (url.endsWith('/models') ? json({ data: [{ id: 'm' }] }) : json({ error: 'unauthorized' }, 401)));
    const adapter = new OpenAIAdapter({ apiKey: 'wrong', model: 'm', baseUrl: EU, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('EUrouter routing rules request failed (HTTP 401)');
    expect(r.error).not.toContain('wrong');
  });

  it('testConnection on EUrouter fails when the configured rule is not in the list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Other' }] }));
    const adapter = new OpenAIAdapter({ apiKey: 'k', model: 'm', baseUrl: EU, ruleId: RULE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await adapter.testConnection()).toEqual({ ok: false, error: 'EUrouter routing rule not found or disabled' });
  });

  it('testConnection on EUrouter passes when the configured rule exists (case-insensitive id)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: RULE.toUpperCase(), name: 'EU only' }] }));
    const adapter = new OpenAIAdapter({ apiKey: 'k', model: 'm', baseUrl: EU, ruleId: RULE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await adapter.testConnection()).toEqual({ ok: true });
  });
});

describe('OpenAIAdapter — PDF chat through EUrouter (LBV2-30)', () => {
  const EU = 'https://api.eurouter.ai/api/v1';
  const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
  const done = () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  const pdfMessage = {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'Summarize the attached PDF.' },
      { type: 'document' as const, media_type: 'application/pdf' as const, data: Buffer.from('%PDF-fake').toString('base64') },
    ],
  };

  async function run(cfg: { extractPdfText?: (d: Uint8Array) => Promise<string>; maxDocumentChars?: number; baseUrl?: string }) {
    const fetchImpl = vi.fn().mockResolvedValue(done());
    const adapter = new OpenAIAdapter({
      apiKey: 'k', model: 'gpt-4o', baseUrl: cfg.baseUrl ?? EU, ruleId: RULE,
      extractPdfText: cfg.extractPdfText, maxDocumentChars: cfg.maxDocumentChars,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.chat({ model: 'gpt-4o', messages: [pdfMessage] })) chunks.push(c);
    return { fetchImpl, chunks };
  }

  it('extracts the PDF text locally and sends it via chat/completions with model and rule_id, never /responses', async () => {
    const extract = vi.fn(async (d: Uint8Array) => { expect(Buffer.from(d).toString()).toBe('%PDF-fake'); return 'Hello EU PDF'; });
    const { fetchImpl, chunks } = await run({ extractPdfText: extract });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${EU}/chat/completions`);
    const body = JSON.parse(String(init.body)) as { model: string; rule_id: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('gpt-4o');
    expect(body.rule_id).toBe(RULE);
    expect(body.messages[0]!.content).toContain('Summarize the attached PDF.');
    expect(body.messages[0]!.content).toContain('Hello EU PDF');
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  it('refuses a PDF whose text is too long for the model context, without calling EUrouter', async () => {
    const { fetchImpl, chunks } = await run({ extractPdfText: async () => 'x'.repeat(101), maxDocumentChars: 100 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const err = chunks.find((c) => c.kind === 'error') as { error: string } | undefined;
    expect(err?.error).toBe('The PDF text (101 characters) is too long for the model context (limit 100 characters). Use a shorter document or raise maxContextChars.');
  });

  it('fails clearly when no local PDF extractor is configured', async () => {
    const { fetchImpl, chunks } = await run({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((chunks.find((c) => c.kind === 'error') as { error: string } | undefined)?.error).toBe('PDF text extraction is not available for EUrouter');
  });

  it('fails clearly when the PDF has no extractable text', async () => {
    const { fetchImpl, chunks } = await run({ extractPdfText: async () => '   ' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((chunks.find((c) => c.kind === 'error') as { error: string } | undefined)?.error).toBe('The PDF contains no extractable text');
  });

  it('keeps using the Responses API for other hosts', async () => {
    const { fetchImpl } = await run({ baseUrl: 'https://api.openai.com', extractPdfText: async () => 'unused' });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.openai.com/v1/responses');
  });
});
