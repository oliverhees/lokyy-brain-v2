import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, emptyState } from './state.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'portal-state-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('StateStore', () => {
  it('starts with an empty state when no file exists', async () => {
    const store = new StateStore(dir);
    expect(await store.read()).toEqual(emptyState());
  });

  it('persists updates to state.json (mode 600) and users.json', async () => {
    const store = new StateStore(dir);
    await store.update((s) => {
      s.company = { name: 'Muster GmbH' };
      s.users.push({ slot: 'v01', username: 'anna', email: 'anna@example.com', displayName: 'Anna', role: 'writer', status: 'invited',
        authentikPk: 7, invitedAt: 't', updatedAt: 't' });
    });
    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(onDisk.company.name).toBe('Muster GmbH');
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    const users = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
    expect(users).toEqual({ companyVault: 'firma', generation: 1, users: [{ username: 'anna', role: 'writer', vault: 'v01', allowVaultNameMismatch: true }] });
    // a fresh store sees the persisted state
    expect((await new StateStore(dir).read()).users).toHaveLength(1);
  });

  it('raises the users.json generation only when the provisioning input changes (or on request)', async () => {
    const store = new StateStore(dir);
    const gen = () => JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')).generation;
    await store.update((s) => { s.company = { name: 'A' }; });
    expect(gen()).toBe(0);
    await store.update((s) => { s.users.push({ slot: 'v01', username: 'anna', email: 'a@example.com', displayName: 'A', role: 'reader', status: 'invited', authentikPk: 1, invitedAt: 't', updatedAt: 't' }); });
    expect(gen()).toBe(1);
    await store.update((s) => { s.company = { name: 'B' }; s.users[0]!.displayName = 'Anna'; });
    expect(gen()).toBe(1);
    await store.update((s) => { s.users[0]!.keyRotation = 'x'; });
    expect(gen()).toBe(2);
    await store.update((s) => { s.usersGeneration += 1; });
    expect(gen()).toBe(3);
    expect((await store.read()).usersGeneration).toBe(3);
  });

  it('leaves no temp files behind', async () => {
    const store = new StateStore(dir);
    await store.update((s) => { s.company = { name: 'x' }; });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('serialises concurrent updates (no lost writes)', async () => {
    const store = new StateStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(async (s) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      s.retired.push({ slot: `v${String(i).padStart(2, '0')}`, formerUsername: `u${i}`, retiredAt: 't' });
    })));
    expect((await store.read()).retired).toHaveLength(20);
  });

  it('does not persist a failed update', async () => {
    const store = new StateStore(dir);
    await expect(store.update((s) => { s.company = { name: 'half' }; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect((await store.read()).company).toBeNull();
  });

  it('returns the update callback result', async () => {
    const store = new StateStore(dir);
    expect(await store.update(() => 42)).toBe(42);
  });

  it('refuses to start on a corrupt state file instead of overwriting it', async () => {
    writeFileSync(join(dir, 'state.json'), '{not json');
    await expect(new StateStore(dir).read()).rejects.toThrow(/state.json/);
  });

  it('keeps secrets in a separate mode-600 file that read() never returns', async () => {
    const store = new StateStore(dir);
    await store.updateSecrets((sec) => { sec.smtpPassword = 'hunter2hunter2'; });
    expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await store.read())).not.toContain('hunter2');
    expect((await store.readSecrets()).smtpPassword).toBe('hunter2hunter2');
  });
});
