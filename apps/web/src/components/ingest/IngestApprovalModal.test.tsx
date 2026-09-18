import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IngestApprovalModal } from './IngestApprovalModal';

// LBV2-32 B: a failed plan (provider error, model without tool calls) must be
// shown as an error, never as an empty "Plan: 0 actions" review.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sse(events: Array<[string, unknown]>, status = 200): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<IngestApprovalModal rawId="raw1" open onClose={() => {}} onDone={() => {}} />);
  });
  // Let the SSE reader drain.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('IngestApprovalModal errors (LBV2-32)', () => {
  it('shows an SSE `error` event as an alert', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse([['started', { rawId: 'raw1' }], ['error', { error: 'HTTP 400: estimated tokens exceed context' }]]),
    );
    await render();
    expect(alertText()).toContain('HTTP 400: estimated tokens exceed context');
    expect(container.textContent).not.toContain('Plan: 0 actions');
  });

  it('treats a `done` event that carries an error as a failure, not an empty plan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse([['started', { rawId: 'raw1' }], ['done', { planId: 'p1', error: 'no tool calls' }]]),
    );
    await render();
    expect(alertText()).toContain('no tool calls');
    expect(container.textContent).not.toContain('Plan: 0 actions');
  });

  it('shows a non-2xx response as an alert with the server message when present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'raw raw1 not found' }), { status: 404, headers: { 'content-type': 'application/json' } }),
    );
    await render();
    expect(alertText()).toContain('raw raw1 not found');
  });

  it('a stream that ends without `done` is reported instead of hanging', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([['started', { rawId: 'raw1' }]]));
    await render();
    expect(alertText()).toMatch(/ended unexpectedly/i);
  });

  it('offers Retry in the error state and re-runs the plan', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse([['started', { rawId: 'raw1' }], ['error', { error: 'The LLM provider is temporarily unavailable. Try again in a moment.' }]]))
      .mockResolvedValueOnce(sse([
        ['started', { rawId: 'raw1' }],
        ['proposed', { action: { id: 'a1', call: { id: 'a1', name: 'create_concept', arguments: { name: 'Rhine' } }, simulatedResult: { ok: true } } }],
        ['done', { planId: 'p2' }],
      ]));
    await render();
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/compile/raw1/plan');
    expect(alertText()).toBeNull();
    expect(container.textContent).toContain('Plan: 1 action');
  });

  it('a successful plan still reaches the review phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse([
        ['started', { rawId: 'raw1' }],
        ['proposed', { action: { id: 'a1', call: { id: 'a1', name: 'create_concept', arguments: { name: 'Rhine' } }, simulatedResult: { ok: true } } }],
        ['done', { planId: 'p1' }],
      ]),
    );
    await render();
    expect(alertText()).toBeNull();
    expect(container.textContent).toContain('Plan: 1 action');
  });
});
