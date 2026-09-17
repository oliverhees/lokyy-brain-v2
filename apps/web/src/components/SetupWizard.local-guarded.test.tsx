import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetupWizard } from './SetupWizard';
import { LOCAL_MODELS_DISABLED_MESSAGE } from '../lib/local-setup';

// LBV2-19 QA: in a guarded vault the Ollama onboarding routes answer 404.
// The wizard must not offer local models there and must never poll forever.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG = { provider: 'openai', model: 'gpt-4o-mini', apiKey: '', baseUrl: '', autoSave: true, mergeSaves: false };

function mockServer(localModels: boolean | undefined): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/health')) return json({ ok: true, features: { capture: true, ...(localModels === undefined ? {} : { localModels }) } });
    if (url.endsWith('/api/config')) return json(CONFIG);
    return json({ error: 'Not found' }, 404);
  }));
  return { calls };
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => { root.render(<SetupWizard mode="onboarding" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

function localOption(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Free — runs on your computer'));
  if (!btn) throw new Error('local option not rendered');
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
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

describe('SetupWizard local models in guarded mode (LBV2-19)', () => {
  it('disables the local option with an explanation when the server reports localModels: false', async () => {
    const { calls } = mockServer(false);
    await render();
    const btn = localOption();
    expect(btn.disabled).toBe(true);
    // QA a11y: the explanation is a separate, non-dimmed hint linked to the card.
    const hintId = btn.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId!);
    expect(hint?.textContent).toBe(LOCAL_MODELS_DISABLED_MESSAGE);
    expect(hint?.closest('button')).toBeNull();
    expect(btn.textContent).not.toContain(LOCAL_MODELS_DISABLED_MESSAGE);
    // --text-mid is the lightest text token with >= 4.5:1 on the card in both themes.
    expect(hint?.getAttribute('style')).toContain('var(--text-mid)');
    await act(async () => { btn.click(); });
    expect(container.querySelector('[data-testid="local-setup-step"]')).toBeNull();
    expect(calls.some((c) => c.includes('/ollama/status'))).toBe(false);
  });

  it('keeps the local option enabled when the server does not report the flag', async () => {
    mockServer(undefined);
    await render();
    expect(localOption().disabled).toBe(false);
  });

  it('stops polling on a 404 from /ollama/status and offers a way back', async () => {
    const { calls } = mockServer(true);
    await render();
    await act(async () => { localOption().click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(calls.filter((c) => c.includes('/ollama/status'))).toHaveLength(1);
    expect(container.textContent).not.toContain('Checking your machine');
    const error = container.querySelector('[data-testid="local-state-error"]');
    expect(error?.textContent).toContain(LOCAL_MODELS_DISABLED_MESSAGE);
    expect(error?.getAttribute('role')).toBe('alert');

    const back = [...(error?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Choose a cloud provider'));
    expect(back).toBeDefined();
    await act(async () => { back!.click(); });
    expect(container.querySelector('[data-testid="local-setup-step"]')).toBeNull();
    expect(localOption().disabled).toBe(true);
    // Focus lands on the provider list heading, not on <body>.
    expect(document.activeElement).toBe(container.querySelector('[data-testid="provider-heading"]'));
  });
});
