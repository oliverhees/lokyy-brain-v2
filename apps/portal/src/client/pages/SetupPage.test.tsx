// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { SetupPage } from './SetupPage.tsx';
import { byText, click, fakeApi, input, mount, type, type Mounted } from '../../../test/fakes/client.tsx';
import { ApiError } from '../api.ts';
import type { SetupStatus } from '../types.ts';

const empty: SetupStatus = {
  company: null, llm: null, smtp: null, setupCompletedAt: null, vaults: ['firma', 'v01', 'v02'],
  slots: { total: 2, free: 2 }, lastProvisioning: null,
};
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });

describe('SetupPage wizard', () => {
  it('walks company → LLM → e-mail (skipped) → done and completes the setup', async () => {
    let status = { ...empty };
    const api = fakeApi({
      'GET /api/admin/setup': () => status,
      'PUT /api/admin/setup/company': (b: unknown) => { status = { ...status, company: b as { name: string } }; return null; },
      'PUT /api/admin/setup/llm': () => { status = { ...status, llm: { mode: 'shared', model: 'm/x', keyHints: { firma: '••••1234', v01: '••••1234', v02: '••••1234' }, baseUrl: 'https://api.eurouter.ai/api/v1' } }; return { failed: [] }; },
      'POST /api/admin/setup/complete': null,
    });
    const done: string[] = [];
    m = await mount(<SetupPage onDone={() => done.push('x')} />, api);
    expect(m.container.textContent).toContain('Schritt 1 von 4');
    expect(m.container.querySelector('[aria-current="step"]')?.textContent).toContain('Firma');

    await type(input(m.container, 'Firmenname'), 'Muster GmbH');
    await click(byText(m.container, 'Weiter'));
    expect(api.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/admin/setup/company', body: { name: 'Muster GmbH' } });
    expect(m.container.textContent).toContain('https://api.eurouter.ai/api/v1');

    await type(input(m.container, 'Modell'), 'm/x');
    await type(input(m.container, 'EUrouter-API-Schlüssel'), 'sk-eu-abcdefghijkl1234');
    await click(byText(m.container, 'Weiter'));
    expect(api.calls.find((c) => c.path === '/api/admin/setup/llm')?.body).toEqual({ mode: 'shared', model: 'm/x', sharedKey: 'sk-eu-abcdefghijkl1234' });
    // the key field is cleared after saving; only the masked hint remains
    expect(m.container.textContent).toContain('Schritt 3 von 4');

    await click(byText(m.container, 'Ohne E-Mail fortfahren'));
    await click(byText(m.container, 'Einrichtung abschließen'));
    expect(api.calls.some((c) => c.path === '/api/admin/setup/complete')).toBe(true);
    expect(done).toEqual(['x']);
  });

  it('shows per-vault key fields and masked hints of stored keys', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': { ...empty, company: { name: 'X' }, llm: { mode: 'per-vault', model: 'm', keyHints: { v01: '••••9999' }, baseUrl: 'https://api.eurouter.ai/api/v1' } } });
    m = await mount(<SetupPage onDone={() => {}} initialStep={1} />, api);
    await click(byText(m.container, 'Eigener Schlüssel je Vault'));
    expect(input(m.container, 'Schlüssel für den Firmen-Vault')).toBeTruthy();
    expect(input(m.container, 'Schlüssel für Vault v01')).toBeTruthy();
    expect(m.container.textContent).toContain('Gespeichert: ••••9999');
    expect(m.container.textContent).not.toMatch(/sk-/);
  });

  it('keeps the user on the step and shows field errors when saving fails', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': empty, 'PUT /api/admin/setup/company': () => new ApiError(400, 'invalid_input', { name: 'required' }) });
    m = await mount(<SetupPage onDone={() => {}} />, api);
    await click(byText(m.container, 'Weiter'));
    expect(m.container.textContent).toContain('Schritt 1 von 4');
    expect(input(m.container, 'Firmenname').getAttribute('aria-invalid')).toBe('true');
  });

  it('reports vaults that could not be configured', async () => {
    const api = fakeApi({ 'GET /api/admin/setup': { ...empty, company: { name: 'X' } }, 'PUT /api/admin/setup/llm': { failed: ['v02'] } });
    m = await mount(<SetupPage onDone={() => {}} />, api);
    await click(byText(m.container, 'Weiter'));
    await type(input(m.container, 'Modell'), 'm');
    await type(input(m.container, 'EUrouter-API-Schlüssel'), 'sk-eu-abcdefghijkl1234');
    await click(byText(m.container, 'Weiter'));
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('v02');
    expect(m.container.textContent).toContain('Schritt 2 von 4');
  });

  it('saves SMTP and can send a test mail', async () => {
    const api = fakeApi({
      'GET /api/admin/setup': { ...empty, company: { name: 'X' }, llm: { mode: 'shared', model: 'm', keyHints: {}, baseUrl: '' } },
      'PUT /api/admin/setup/smtp': null, 'POST /api/admin/setup/smtp/test': null,
    });
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
