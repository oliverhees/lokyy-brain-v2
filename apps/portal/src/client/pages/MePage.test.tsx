// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MePage } from './MePage.tsx';
import { byText, click, fakeApi, mount, type Mounted } from '../../../test/fakes/client.tsx';
import { ApiError } from '../api.ts';
import type { MyAccess } from '../types.ts';

const me: MyAccess = {
  username: 'anna', displayName: 'Anna Muster', slot: 'v01', role: 'reader', companyName: 'Muster GmbH',
  vaultUrl: 'https://v01.example.com', companyVaultUrl: null, mcpUrl: 'https://mcp.example.com/metamcp/anna/mcp',
  serverName: 'lokyy', provisioning: 'ok',
};
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; vi.restoreAllMocks(); });

describe('MePage', () => {
  it('shows vault link, MCP URL and snippets with a placeholder until the key is revealed', async () => {
    const api = fakeApi({ 'GET /api/me': me, 'POST /api/me/key/reveal': { apiKey: 'sk_mt_secret1' } });
    m = await mount(<MePage />, api);
    const link = m.container.querySelector<HTMLAnchorElement>('a[href="https://v01.example.com"]')!;
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(m.container.textContent).toContain('https://mcp.example.com/metamcp/anna/mcp');
    expect(m.container.textContent).toContain('Bearer <API-SCHLÜSSEL>');
    expect(m.container.textContent).not.toContain('sk_mt_secret1');
    // readers get no company-vault web link, but an explanation
    expect(m.container.textContent).toContain('nur lesen');

    await click(byText(m.container, 'Schlüssel anzeigen'));
    expect(api.calls.some((c) => c.path === '/api/me/key/reveal')).toBe(true);
    expect(m.container.textContent).toContain('claude mcp add --transport http lokyy https://mcp.example.com/metamcp/anna/mcp --header "Authorization: Bearer sk_mt_secret1"');

    await click(byText(m.container, 'Verbergen'));
    expect(m.container.textContent).not.toContain('sk_mt_secret1');
  });

  it('regenerates only after confirmation and shows the new key', async () => {
    const api = fakeApi({ 'GET /api/me': me, 'POST /api/me/key/rotate': { apiKey: 'sk_mt_new' } });
    m = await mount(<MePage />, api);
    await click(byText(m.container, 'Neuen Schlüssel erzeugen'));
    expect(api.calls.some((c) => c.path === '/api/me/key/rotate')).toBe(false);
    const dialogConfirm = [...m.container.querySelectorAll('dialog button')].find((b) => b.textContent?.includes('Neuen Schlüssel erzeugen')) as HTMLElement;
    await click(dialogConfirm);
    expect(api.calls.some((c) => c.path === '/api/me/key/rotate')).toBe(true);
    expect(m.container.textContent).toContain('sk_mt_new');
    expect(m.container.textContent).toContain('Neuer Schlüssel erzeugt');
  });

  it('writers get the company vault link', async () => {
    m = await mount(<MePage />, fakeApi({ 'GET /api/me': { ...me, role: 'writer', companyVaultUrl: 'https://firma.example.com' } }));
    expect(m.container.querySelector('a[href="https://firma.example.com"]')).not.toBeNull();
  });

  it('users without access see a clear message instead of an error', async () => {
    m = await mount(<MePage />, fakeApi({ 'GET /api/me': () => new ApiError(404, 'no_access') }));
    expect(m.container.textContent).toContain('noch kein Zugang eingerichtet');
  });

  it('load errors offer a retry', async () => {
    let fail = true;
    const api = fakeApi({ 'GET /api/me': () => (fail ? new ApiError(0, 'network') : me) });
    m = await mount(<MePage />, api);
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('Keine Verbindung');
    fail = false;
    await click(byText(m.container, 'Erneut versuchen'));
    expect(m.container.textContent).toContain('Anna Muster');
  });

  it('a failed reveal is announced', async () => {
    m = await mount(<MePage />, fakeApi({ 'GET /api/me': me, 'POST /api/me/key/reveal': () => new ApiError(409, 'key_not_provisioned') }));
    await click(byText(m.container, 'Schlüssel anzeigen'));
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('wird noch eingerichtet');
  });
});
