// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { click, fakeApi, mount, type Mounted } from '../../test/fakes/client.tsx';
import { ApiError } from './api.ts';

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; window.location.hash = ''; });

const session = (o: object) => ({ username: 'akadmin', isAdmin: true, csrfToken: 'tok', hasAccess: false, setupComplete: true, companyName: 'Muster GmbH', ...o });
const setup = { company: { name: 'Muster GmbH' }, llm: null, smtp: null, setupCompletedAt: null, vaults: ['firma', 'v01'], slots: { total: 1, free: 1 }, lastProvisioning: null };

describe('App shell', () => {
  it('admins get the full navigation; an unfinished setup opens the wizard', async () => {
    m = await mount(<App />, fakeApi({ 'GET /api/session': session({ setupComplete: false }), 'GET /api/admin/setup': setup }));
    const nav = m.container.querySelector('nav[aria-label="Hauptnavigation"]')!;
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Einrichtung', 'Mitarbeitende', 'Protokoll']);
    expect(m.container.querySelector('h1')?.textContent).toBe('Einrichtung');
    expect(m.container.querySelector('a[aria-current="page"]')?.textContent).toBe('Einrichtung');
  });

  it('admins with their own slot also see "Mein Zugang"', async () => {
    m = await mount(<App />, fakeApi({ 'GET /api/session': session({ hasAccess: true }), 'GET /api/admin/users': { users: [], retired: [], freeSlots: 1, lastProvisioning: null } }));
    expect(m.container.textContent).toContain('Mein Zugang');
    expect(m.container.querySelector('h1')?.textContent).toBe('Mitarbeitende');
  });

  it('employees only get "Mein Zugang", even when they type an admin route', async () => {
    window.location.hash = '#/users';
    const api = fakeApi({ 'GET /api/session': session({ username: 'anna', isAdmin: false, hasAccess: true }), 'GET /api/me': () => new ApiError(404, 'no_access') });
    m = await mount(<App />, api);
    expect(m.container.textContent).not.toContain('Mitarbeitende');
    expect(api.calls.some((c) => c.path.startsWith('/api/admin'))).toBe(false);
  });

  it('has a skip link to the main content', async () => {
    m = await mount(<App />, fakeApi({ 'GET /api/session': session({}), 'GET /api/admin/users': { users: [], retired: [], freeSlots: 1, lastProvisioning: null } }));
    const skip = m.container.querySelector('a[href="#main"]')!;
    expect(skip.textContent).toBe('Zum Inhalt springen');
    expect(m.container.querySelector('main#main')).not.toBeNull();
  });

  it('shows an error with retry when the session cannot be loaded', async () => {
    let fail = true;
    m = await mount(<App />, fakeApi({ 'GET /api/session': () => (fail ? new ApiError(0, 'network') : session({})), 'GET /api/admin/users': { users: [], retired: [], freeSlots: 1, lastProvisioning: null } }));
    expect(m.container.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    await click([...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Erneut versuchen')!);
    expect(m.container.querySelector('h1')?.textContent).toBe('Mitarbeitende');
  });
});
