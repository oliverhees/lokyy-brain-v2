import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetupWizard } from './SetupWizard';
import { useSettings } from '../store/settings';

// LBV2-30: EUrouter as a provider with a Route picker; the route id is stored, the model is optional.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EU = 'https://api.eurouter.ai/api/v1';
const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
const CONFIG = { provider: 'openai', model: '', apiKey: '********', hasApiKey: true, baseUrl: EU, ruleId: RULE, autoSave: true, mergeSaves: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockServer(): Array<{ url: string; method: string; body: Record<string, unknown> | null }> {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.endsWith('/api/health')) return json({ ok: true, features: {} });
    if (url.endsWith('/api/config') && (init?.method ?? 'GET') === 'GET') return json(CONFIG);
    if (url.endsWith('/api/config') && init?.method === 'PUT') return json({ ok: true });
    if (url.endsWith('/api/config/eurouter/rules')) return json({ rules: [{ id: RULE, name: 'EU only', model: 'mistral/mistral-large' }] });
    if (url.endsWith('/api/config/test')) return json({ ok: true });
    return json({ error: 'Not found' }, 404);
  }));
  return calls;
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

function button(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not rendered`);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
  useSettings.setState({ loaded: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SetupWizard EUrouter route (LBV2-30)', () => {
  it('detects EUrouter, preselects the stored route and saves it without a model', async () => {
    const calls = mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('EUrouter').click(); });
    await flush();
    const select = container.querySelector('[data-testid="eurouter-route-select"]') as HTMLSelectElement;
    expect(select.value).toBe(RULE);
    expect(container.textContent).toContain('mistral/mistral-large');
    const rulesCall = calls.find((c) => c.url.endsWith('/api/config/eurouter/rules'));
    expect(rulesCall?.body).toEqual({ provider: 'openai', baseUrl: EU, apiKey: '********' });

    const save = button('Test & Save');
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    await flush();
    const test = calls.find((c) => c.url.endsWith('/api/config/test'));
    expect(test?.body).toMatchObject({ provider: 'openai', baseUrl: EU, model: '', ruleId: RULE });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ provider: 'openai', baseUrl: EU, ruleId: RULE });
  });

  it('needs a model again when no route is chosen', async () => {
    mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('EUrouter').click(); });
    await flush();
    const select = container.querySelector('[data-testid="eurouter-route-select"]') as HTMLSelectElement;
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button('Test & Save').disabled).toBe(true);
  });

  it('does not show the route picker for other providers and clears the route there', async () => {
    const calls = mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('Anthropic').click(); });
    await flush();
    expect(container.querySelector('[data-testid="eurouter-route-select"]')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/api/config/eurouter/rules'))).toBe(false);
  });
});
