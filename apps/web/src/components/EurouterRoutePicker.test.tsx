import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EurouterRoutePicker } from './EurouterRoutePicker';

// LBV2-30: route picker for EUrouter routing rules (loading / empty / error / list).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EU = 'https://api.eurouter.ai/api/v1';
const RULE = '3f1c2b9a-8d4e-4f6a-9b2c-1d2e3f4a5b6c';
const RULES = [
  { id: RULE, name: 'EU only', model: 'mistral/mistral-large' },
  { id: '11111111-2222-4333-8444-555555555555', name: 'Cheap', model: null },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let container: HTMLDivElement;
let root: Root;
let onChange: ReturnType<typeof vi.fn>;

async function render(props: { apiKey: string; value?: string }): Promise<void> {
  await act(async () => {
    root.render(<EurouterRoutePicker provider="openai" baseUrl={EU} apiKey={props.apiKey} value={props.value ?? ''} onChange={onChange} />);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  onChange = vi.fn();
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

describe('EurouterRoutePicker', () => {
  it('asks for a key first and does not call the server without one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await render({ apiKey: '' });
    expect(q('eurouter-routes-need-key')?.textContent).toMatch(/API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a loading state, then the rules by name with the id as value', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    await render({ apiKey: 'eur_k' });
    expect(q('eurouter-routes-loading')?.getAttribute('role')).toBe('status');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/config/eurouter/rules');
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'openai', baseUrl: EU, apiKey: 'eur_k' });
    await act(async () => { resolve(json({ rules: RULES })); });
    const select = q('eurouter-route-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const label = container.querySelector(`label[for="${select.id}"]`);
    expect(label?.textContent).toMatch(/Route/);
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Choose a route…'], [RULE, 'EU only'], ['11111111-2222-4333-8444-555555555555', 'Cheap'],
    ]);
    await act(async () => {
      select.value = RULE;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(RULE, RULES[0]);
  });

  it('explains that the route brings its models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ rules: RULES })));
    await render({ apiKey: 'eur_k', value: RULE });
    expect(q('eurouter-route-help')?.textContent).toContain('mistral/mistral-large');
    expect(q('eurouter-route-help')?.textContent).toMatch(/route picks the model/i);
  });

  it('says the key is invalid when the server reports it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Key invalid or not authorised' }, 400)));
    await render({ apiKey: 'eur_wrong' });
    expect(q('eurouter-routes-error')?.textContent).toContain('Key invalid or not authorised');
  });

  it('shows an empty state when the key has no routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ rules: [] })));
    await render({ apiKey: 'eur_k' });
    expect(q('eurouter-routes-empty')?.textContent).toMatch(/No routes/);
  });

  it('shows an error with a retry', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'Could not load EUrouter routes' }, 502));
    vi.stubGlobal('fetch', fetchMock);
    await render({ apiKey: 'eur_k' });
    const err = q('eurouter-routes-error');
    expect(err?.getAttribute('role')).toBe('alert');
    expect(err?.textContent).toContain('Could not load EUrouter routes');
    fetchMock.mockImplementation(async () => json({ rules: RULES }));
    await act(async () => { (err?.querySelector('button') as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(q('eurouter-route-select')).toBeTruthy();
  });

  it('keeps a stored route that the list no longer contains visible, marked unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ rules: [RULES[1]] })));
    await render({ apiKey: 'eur_k', value: RULE });
    const select = q('eurouter-route-select') as HTMLSelectElement;
    expect(select.value).toBe(RULE);
    expect(select.selectedOptions[0]?.textContent).toMatch(/not available/);
  });
});
