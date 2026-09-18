// Test helpers for client components: happy-dom + react-dom act, with a scripted Api.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApiContext } from '../../src/client/context.tsx';
import { ApiError, type Api } from '../../src/client/api.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Handler = (body: unknown) => unknown;
export interface FakeApi extends Api { calls: { method: string; path: string; body: unknown }[] }

/** routes: "GET /api/me" → value or handler; a thrown ApiError is returned as error. */
export function fakeApi(routes: Record<string, unknown>): FakeApi {
  const calls: FakeApi['calls'] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const r = routes[`${method} ${path}`];
    if (r === undefined) throw new ApiError(404, 'not_found');
    const v = typeof r === 'function' ? (r as Handler)(body) : r;
    if (v instanceof ApiError) throw v;
    return v as never;
  };
  return {
    calls,
    setCsrf: () => {},
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
}

export interface Mounted { root: Root; container: HTMLElement; unmount(): void }

export async function mount(ui: ReactNode, api: Api): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ApiContext.Provider value={api}>{ui}</ApiContext.Provider>); });
  await flush();
  return { root, container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

export const byText = (c: HTMLElement, text: string | RegExp): HTMLElement => {
  const all = [...c.querySelectorAll<HTMLElement>('button, a, label, h1, h2, h3, p, span, legend, td, th, li, pre, div')];
  const hit = all.find((el) => (typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? '')) && [...el.children].every((ch) => !(typeof text === 'string' ? ch.textContent?.trim() === text : text.test(ch.textContent ?? ''))));
  if (!hit) throw new Error(`no element with text ${String(text)}`);
  return hit;
};

export const input = (c: HTMLElement, label: string): HTMLInputElement => {
  const l = [...c.querySelectorAll('label')].find((x) => x.textContent?.startsWith(label));
  if (!l) throw new Error(`no label ${label}`);
  const el = (l.htmlFor ? c.querySelector(`#${CSS.escape(l.htmlFor)}`) : l.querySelector('input')) as HTMLInputElement | null;
  if (!el) throw new Error(`no input for ${label}`);
  return el;
};

export async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); });
  await flush();
}
