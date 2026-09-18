// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { UsersPage } from './UsersPage.tsx';
import { byText, click, fakeApi, input, mount, type, type Mounted } from '../../../test/fakes/client.tsx';
import { ApiError } from '../api.ts';
import type { UserRow, UsersResponse } from '../types.ts';

const row = (o: Partial<UserRow> = {}): UserRow => ({
  slot: 'v01', username: 'anna', email: 'anna@example.com', displayName: 'Anna Muster', role: 'reader', status: 'active',
  provisioning: 'ok', invitedAt: '2026-09-01T10:00:00Z', activatedAt: '2026-09-02T10:00:00Z', ...o,
});
const list = (users: UserRow[], extra: Partial<UsersResponse> = {}): UsersResponse => ({ users, retired: [], freeSlots: 2, lastProvisioning: null, ...extra });

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });

describe('UsersPage', () => {
  it('shows an empty state with the invite action', async () => {
    m = await mount(<UsersPage />, fakeApi({ 'GET /api/admin/users': list([]) }));
    expect(m.container.textContent).toContain('Noch niemand eingeladen');
    expect(m.container.textContent).toContain('2 Vault-Plätze frei');
  });

  it('lists users in an accessible table with German status and role', async () => {
    m = await mount(<UsersPage />, fakeApi({ 'GET /api/admin/users': list([row(), row({ slot: 'v02', username: 'ben', displayName: 'Ben', role: 'writer', status: 'invited' })]) }));
    const table = m.container.querySelector('table')!;
    expect(table.querySelector('caption')?.textContent).toBe('Eingeladene Mitarbeitende');
    expect([...table.querySelectorAll('th[scope="col"]')].length).toBeGreaterThan(3);
    expect(table.textContent).toContain('Aktiv');
    expect(table.textContent).toContain('Eingeladen');
    expect(table.textContent).toContain('Lesen und schreiben');
  });

  it('invites: server field errors appear at the fields; success shows the copyable link', async () => {
    let attempt = 0;
    const api = fakeApi({
      'GET /api/admin/users': list([]),
      'POST /api/admin/users': () => (++attempt === 1
        ? new ApiError(400, 'invalid_input', { username: 'reserved' })
        : { user: row({ status: 'invited' }), inviteLink: 'https://auth.example.com/if/flow/lokyy-set-password/?flow_token=abc', mailed: false }),
    });
    m = await mount(<UsersPage />, api);
    await click(byText(m.container, 'Mitarbeitende einladen'));
    await type(input(m.container, 'Name'), 'Anna Muster');
    await type(input(m.container, 'E-Mail-Adresse'), 'anna@example.com');
    await type(input(m.container, 'Benutzername'), 'admin');
    await click(byText(m.container, 'Einladen'));
    const u = input(m.container, 'Benutzername');
    expect(u.getAttribute('aria-invalid')).toBe('true');
    expect(m.container.textContent).toContain('Dieser Name ist reserviert.');
    await type(u, 'anna');
    await click(byText(m.container, 'Einladen'));
    expect(api.calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ displayName: 'Anna Muster', email: 'anna@example.com', username: 'anna', role: 'reader' });
    expect(m.container.textContent).toContain('flow_token=abc');
    expect(m.container.textContent).toContain('Geben Sie diesen Link an die Person weiter');
  });

  it('suggests a username from the name', async () => {
    m = await mount(<UsersPage />, fakeApi({ 'GET /api/admin/users': list([]) }));
    await click(byText(m.container, 'Mitarbeitende einladen'));
    await type(input(m.container, 'Name'), 'Jürgen Müller');
    expect(input(m.container, 'Benutzername').value).toBe('juergen-mueller');
  });

  it('shows a conflict (no free slot) as a form error', async () => {
    m = await mount(<UsersPage />, fakeApi({ 'GET /api/admin/users': list([]), 'POST /api/admin/users': () => new ApiError(409, 'no_free_slot') }));
    await click(byText(m.container, 'Mitarbeitende einladen'));
    await type(input(m.container, 'Name'), 'Anna');
    await type(input(m.container, 'E-Mail-Adresse'), 'anna@example.com');
    await click(byText(m.container, 'Einladen'));
    expect(m.container.querySelector('dialog [role="alert"]')?.textContent).toContain('Alle Vault-Plätze sind belegt');
  });

  it('remove needs the typed username', async () => {
    const api = fakeApi({ 'GET /api/admin/users': list([row()]), 'DELETE /api/admin/users/anna': null });
    m = await mount(<UsersPage />, api);
    await click(byText(m.container, 'Entfernen'));
    const confirm = [...m.container.querySelectorAll('dialog button')].find((b) => b.textContent === 'Endgültig entfernen') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(input(m.container, 'Zur Bestätigung'), 'anna');
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(api.calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: '/api/admin/users/anna', body: { confirm: 'anna', keepData: true } });
    expect(m.container.textContent).toContain('Person entfernt');
  });

  it('role change and disable call the API; failures are announced', async () => {
    const api = fakeApi({
      'GET /api/admin/users': list([row()]),
      'PATCH /api/admin/users/anna': { user: row({ role: 'writer' }) },
      'POST /api/admin/users/anna/disable': () => new ApiError(502, 'authentik_failed'),
    });
    m = await mount(<UsersPage />, api);
    await click(byText(m.container, 'Schreibrechte geben'));
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ role: 'writer' });
    await click(byText(m.container, 'Deaktivieren'));
    const confirm = [...m.container.querySelectorAll('dialog button')].find((b) => b.textContent === 'Deaktivieren') as HTMLElement;
    await click(confirm);
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('nicht erreichbar');
  });

  it('warns about failed provisioning and offers a retry', async () => {
    const api = fakeApi({
      'GET /api/admin/users': list([row({ provisioning: 'failed' })], { lastProvisioning: { at: 't', status: 'failed', restartMetamcp: false } }),
      'POST /api/admin/provision': { status: 'ok' },
    });
    m = await mount(<UsersPage />, api);
    expect(m.container.textContent).toContain('MCP-Zugang fehlgeschlagen');
    await click(byText(m.container, 'MCP-Zugang erneut einrichten'));
    expect(api.calls.some((c) => c.path === '/api/admin/provision')).toBe(true);
  });

  it('lists retired slots', async () => {
    m = await mount(<UsersPage />, fakeApi({ 'GET /api/admin/users': list([], { retired: [{ slot: 'v03', formerUsername: 'carl', retiredAt: 't' }] }) }));
    expect(m.container.textContent).toContain('v03 – zuletzt carl');
  });
});
