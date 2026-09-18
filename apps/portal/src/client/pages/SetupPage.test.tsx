// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { SetupPage } from './SetupPage.tsx';
import { byText, choose, click, fakeApi, input, mount, selectByLabel, type, type Mounted } from '../../../test/fakes/client.tsx';
import { ApiError } from '../api.ts';
import type { SetupStatus } from '../types.ts';

const KEY = 'sk-eu-abcdefghijkl1234';
const ROUTES = { routes: [{ id: 'r-a', name: 'eu-standard' }, { id: 'r-b', name: 'eu-premium' }] };
const empty: SetupStatus = {
  company: null, llm: null, smtp: null, setupCompletedAt: null, vaults: ['firma', 'v01', 'v02'], slots: { total: 2, free: 2 }, lastProvisioning: null,
};
const configured = { mode: 'shared' as const, baseUrl: 'https://api.eurouter.ai/api/v1',
  vaults: { firma: { keyHint: '••••1234', ruleId: 'r-a', ruleName: 'eu-standard' }, v01: { keyHint: '••••1234', ruleId: 'r-a', ruleName: 'eu-standard' } } };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });

describe('SetupPage wizard', () => {
  it('company → EUrouter key → load routes → pick route → e-mail skipped → done', async () => {
    let status = { ...empty };
    const api = fakeApi({
      'GET /api/admin/setup': () => status,
      'PUT /api/admin/setup/company': (b: unknown) => { status = { ...status, company: b as { name: string } }; return null; },
      'POST /api/admin/setup/llm/routes': ROUTES,
      'PUT /api/admin/setup/llm': () => { status = { ...status, llm: configured }; return { failed: [] }; },
      'POST /api/admin/setup/complete': null,
    });
    const done: string[] = [];
    m = await mount(<SetupPage onDone={() => done.push('x')} />, api);
    expect(m.container.textContent).toContain('Schritt 1 von 4');
    await type(input(m.container, 'Firmenname'), 'Muster GmbH');
    await click(byText(m.container, 'Weiter'));
    expect(m.container.textContent).toContain('https://api.eurouter.ai/api/v1');
    expect(m.container.textContent).not.toMatch(/Modell-ID/);

    await type(input(m.container, 'EUrouter-API-Schlüssel'), KEY);
    await click(byText(m.container, 'Routen laden'));
    expect(api.calls.find((c) => c.path === '/api/admin/setup/llm/routes')?.body).toEqual({ apiKey: KEY });
    const sel = selectByLabel(m.container, 'Route');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Route wählen …', 'eu-standard', 'eu-premium']);
    await choose(sel, 'r-b');
    await click(byText(m.container, 'Weiter'));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/admin/setup/llm')?.body).toEqual({ mode: 'shared', apiKey: KEY, ruleId: 'r-b' });
    expect(m.container.textContent).toContain('Schritt 3 von 4');

    await click(byText(m.container, 'Ohne E-Mail fortfahren'));
    await click(byText(m.container, 'Einrichtung abschließen'));
    expect(api.calls.some((c) => c.path === '/api/admin/setup/complete')).toBe(true);
    expect(done).toEqual(['x']);
  });

  it('a rejected key is shown at the key field', async () => {
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, fakeApi({
      'GET /api/admin/setup': { ...empty, company: { name: 'X' } },
      'POST /api/admin/setup/llm/routes': () => new ApiError(400, 'invalid_input', { apiKey: 'invalid_key' }),
    }));
    await type(input(m.container, 'EUrouter-API-Schlüssel'), 'sk-eu-wrong-0000000');
    await click(byText(m.container, 'Routen laden'));
    expect(input(m.container, 'EUrouter-API-Schlüssel').getAttribute('aria-invalid')).toBe('true');
    expect(m.container.textContent).toContain('Der Schlüssel ist ungültig oder nicht berechtigt.');
  });

  it('an account without routes gets a clear hint', async () => {
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, fakeApi({ 'GET /api/admin/setup': empty, 'POST /api/admin/setup/llm/routes': { routes: [] } }));
    await type(input(m.container, 'EUrouter-API-Schlüssel'), KEY);
    await click(byText(m.container, 'Routen laden'));
    expect(m.container.textContent).toContain('noch keine aktive Route');
  });

  it('with a stored configuration: shows current route and hint, "Weiter" without re-entering keeps it', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': { ...empty, company: { name: 'X' }, llm: configured } });
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, api);
    expect(m.container.textContent).toContain('Aktuell: Route „eu-standard“, Schlüssel ••••1234');
    await click(byText(m.container, 'Weiter'));
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(m.container.textContent).toContain('Schritt 3 von 4');
  });

  it('per vault: own key and route per vault; only filled vaults are sent', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': { ...empty, company: { name: 'X' }, llm: configured }, 'POST /api/admin/setup/llm/routes': ROUTES, 'PUT /api/admin/setup/llm': { failed: [] } });
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, api);
    await click(m.container.querySelector<HTMLInputElement>('input[type=radio][value="per-vault"]')!);
    expect([...m.container.querySelectorAll('fieldset legend')].map((l) => l.textContent)).toEqual(expect.arrayContaining(['Firmen-Vault', 'Vault v01', 'Vault v02']));
    await type(input(m.container, 'Schlüssel für Vault v02'), KEY);
    const loadV02 = [...m.container.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')?.textContent === 'Vault v02')!;
    await click([...loadV02.querySelectorAll('button')].find((b) => b.textContent === 'Routen laden')!);
    await choose(selectByLabel(m.container, 'Route für Vault v02'), 'r-a');
    await click(byText(m.container, 'Weiter'));
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ mode: 'per-vault', vaults: { v02: { apiKey: KEY, ruleId: 'r-a' } } });
  });

  it('reports vaults that could not be configured and stays on the step', async () => {
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, fakeApi({
      'GET /api/admin/setup': { ...empty, company: { name: 'X' } }, 'POST /api/admin/setup/llm/routes': ROUTES, 'PUT /api/admin/setup/llm': { failed: ['v02'] } }));
    await type(input(m.container, 'EUrouter-API-Schlüssel'), KEY);
    await click(byText(m.container, 'Routen laden'));
    await choose(selectByLabel(m.container, 'Route'), 'r-a');
    await click(byText(m.container, 'Weiter'));
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('v02');
    expect(m.container.textContent).toContain('Schritt 2 von 4');
  });

  it('keeps the user on the company step with field errors when saving fails', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': empty, 'PUT /api/admin/setup/company': () => new ApiError(400, 'invalid_input', { name: 'required' }) });
    m = await mount(<SetupPage onDone={() => {}} />, api);
    await click(byText(m.container, 'Weiter'));
    expect(m.container.textContent).toContain('Schritt 1 von 4');
    expect(input(m.container, 'Firmenname').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input(m.container, 'Firmenname'));
  });

  it('saves SMTP and can send a test mail', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': { ...empty, company: { name: 'X' }, llm: configured }, 'PUT /api/admin/setup/smtp': null, 'POST /api/admin/setup/smtp/test': null });
    m = await mount(<SetupPage onDone={() => {}} initialStep={2} />, api);
    await type(input(m.container, 'SMTP-Server'), 'smtp.example.com');
    await type(input(m.container, 'Absender'), 'noreply@example.com');
    await type(input(m.container, 'Test-E-Mail an'), 'me@example.com');
    await click(byText(m.container, 'Test-E-Mail senden'));
    expect(api.calls.find((c) => c.path === '/api/admin/setup/smtp')?.body).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false, from: 'noreply@example.com' });
    expect(api.calls.find((c) => c.path === '/api/admin/setup/smtp/test')?.body).toEqual({ to: 'me@example.com' });
    expect(m.container.textContent).toContain('Test-E-Mail wurde gesendet');
  });
});
