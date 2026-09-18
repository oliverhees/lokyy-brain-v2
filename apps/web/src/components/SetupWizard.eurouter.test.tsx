import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetupWizard } from './SetupWizard';
import { useSettings } from '../store/settings';

// LBV2-30 (Oliver): EUrouter is configured by route only. No model field; the rule brings its models.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EU = 'https://api.eurouter.ai/api/v1';
const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
const CONFIG = { provider: 'openai', model: '', apiKey: '********', hasApiKey: true, baseUrl: EU, ruleId: RULE, ruleName: 'EU only', autoSave: true, mergeSaves: false };
const OPENAI = { provider: 'openai', model: 'gpt-4o-mini', apiKey: '********', hasApiKey: true, baseUrl: '', autoSave: true, mergeSaves: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockServer(config: Record<string, unknown> = CONFIG): Array<{ url: string; method: string; body: Record<string, unknown> | null }> {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.endsWith('/api/health')) return json({ ok: true, features: {} });
    if (url.endsWith('/api/config') && (init?.method ?? 'GET') === 'GET') return json(config);
    if (url.endsWith('/api/config') && init?.method === 'PUT') return json({ ok: true });
    if (url.endsWith('/api/config/eurouter/rules')) {
      return json({ rules: [{ id: RULE, name: 'EU only', model: 'glm-5.2' }, { id: '11111111-2222-4333-8444-555555555555', name: 'EU Compliance', model: null }] });
    }
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

const textInputs = () => [...container.querySelectorAll('input')].filter((i) => i.type === 'text');

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pick(ruleId: string): Promise<void> {
  const select = container.querySelector('[data-testid="eurouter-route-select"]') as HTMLSelectElement;
  await act(async () => {
    select.value = ruleId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
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

describe('SetupWizard EUrouter route only (LBV2-30)', () => {
  it('shows no model field, preselects the stored route and saves route id + name with an empty model', async () => {
    const calls = mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('EUrouter').click(); });
    await flush();
    expect(textInputs()).toHaveLength(0);
    expect((container.querySelector('[data-testid="eurouter-route-select"]') as HTMLSelectElement).value).toBe(RULE);
    await pick('11111111-2222-4333-8444-555555555555');
    await act(async () => { button('Test & Save').click(); });
    await flush();
    const test = calls.find((c) => c.url.endsWith('/api/config/test'));
    expect(test?.body).toMatchObject({ provider: 'openai', baseUrl: EU, model: '', ruleId: '11111111-2222-4333-8444-555555555555' });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ baseUrl: EU, model: '', ruleId: '11111111-2222-4333-8444-555555555555', ruleName: 'EU Compliance' });
  });

  it('needs a route: Test & Save stays disabled without one', async () => {
    mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('EUrouter').click(); });
    await flush();
    await pick('');
    expect(button('Test & Save').disabled).toBe(true);
  });

  it('switching from OpenAI drops the old model; a key and a route are enough', async () => {
    const calls = mockServer(OPENAI);
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('EUrouter').click(); });
    await flush();
    expect(textInputs()).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith('/api/config/eurouter/rules'))).toBe(false);
    await type([...container.querySelectorAll('input')].find((i) => i.type === 'password')!, 'eur_new');
    await flush();
    await pick(RULE);
    expect(button('Test & Save').disabled).toBe(false);
    await act(async () => { button('Test & Save').click(); });
    await flush();
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ model: '', ruleId: RULE, ruleName: 'EU only' });
  });

  it('shows the model field again for other providers and never loads routes there', async () => {
    const calls = mockServer();
    await act(async () => { root.render(<SetupWizard mode="settings" />); });
    await flush();
    await act(async () => { button('Anthropic').click(); });
    await flush();
    expect(container.querySelector('[data-testid="eurouter-route-select"]')).toBeNull();
    expect(textInputs()).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/api/config/eurouter/rules'))).toBe(false);
  });
});
