import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProvisioning, provisioningView, type ClientsFile } from './provisioning.ts';
import type { UsersJson } from './slots.ts';

const users = (generation: number, ...u: [string, 'reader' | 'writer', string, string?][]): UsersJson => ({
  companyVault: 'firma', generation,
  users: u.map(([username, role, vault, keyRotation]) => ({ username, role, vault, allowVaultNameMismatch: true as const, ...(keyRotation ? { keyRotation } : {}) })),
});
const clients = (sourceGeneration: number | undefined, status: 'ok' | 'failed', ...u: [string, string, string?, boolean?][]): ClientsFile => ({
  generatedAt: '2026-09-18T12:00:00.000Z', status, restartMetamcp: false, ...(sourceGeneration !== undefined ? { sourceGeneration } : {}),
  ...(status === 'failed' ? { error: 'boom' } : {}),
  users: u.map(([username, apiKey, keyRotation, stale]) => ({ username, role: 'reader', vault: 'v01', url: `https://mcp.example.com/metamcp/${username}/mcp`, apiKey, ...(keyRotation ? { keyRotation } : {}), ...(stale ? { stale } : {}) })),
});

describe('provisioningView', () => {
  it('everyone is pending before the watcher wrote anything', () => {
    const v = provisioningView(users(1, ['anna', 'reader', 'v01']), null);
    expect(v.overall).toEqual({ state: 'pending', at: null, error: null, restartMetamcp: false });
    expect(v.user('anna')).toEqual({ state: 'pending', url: null, apiKey: null });
  });

  it('ok when the watcher processed the current generation', () => {
    const v = provisioningView(users(3, ['anna', 'reader', 'v01']), clients(3, 'ok', ['anna', 'sk_mt_a']));
    expect(v.overall.state).toBe('ok');
    expect(v.user('anna')).toEqual({ state: 'ok', url: 'https://mcp.example.com/metamcp/anna/mcp', apiKey: 'sk_mt_a' });
  });

  it('an older result means pending, but an unchanged user keeps a usable key', () => {
    const v = provisioningView(users(4, ['anna', 'reader', 'v01'], ['ben', 'writer', 'v02']), clients(3, 'ok', ['anna', 'sk_mt_a']));
    expect(v.overall.state).toBe('pending');
    expect(v.user('anna')).toMatchObject({ state: 'ok', apiKey: 'sk_mt_a' });
    expect(v.user('ben')).toEqual({ state: 'pending', url: null, apiKey: null });
  });

  it('a requested rotation hides the old key until the watcher applied it', () => {
    const before = provisioningView(users(5, ['anna', 'reader', 'v01', 'r2']), clients(4, 'ok', ['anna', 'sk_mt_old', 'r1']));
    expect(before.user('anna')).toEqual({ state: 'pending', url: 'https://mcp.example.com/metamcp/anna/mcp', apiKey: null });
    const after = provisioningView(users(5, ['anna', 'reader', 'v01', 'r2']), clients(5, 'ok', ['anna', 'sk_mt_new', 'r2']));
    expect(after.user('anna')).toMatchObject({ state: 'ok', apiKey: 'sk_mt_new' });
  });

  it('a failed run marks users without (fresh) entry as failed and reports the error', () => {
    const v = provisioningView(users(2, ['anna', 'reader', 'v01'], ['ben', 'reader', 'v02']), clients(2, 'failed', ['anna', 'sk_mt_a'], ['ben', 'sk_mt_b', undefined, true]));
    expect(v.overall).toMatchObject({ state: 'failed', error: 'boom' });
    expect(v.user('anna').state).toBe('ok');
    expect(v.user('ben')).toEqual({ state: 'failed', url: null, apiKey: null });
  });

  it('a result without sourceGeneration (older watcher) counts as current', () => {
    expect(provisioningView(users(9, ['anna', 'reader', 'v01']), clients(undefined, 'ok', ['anna', 'sk'])).overall.state).toBe('ok');
  });

  it('users not in users.json have no access record', () => {
    expect(provisioningView(users(1), clients(1, 'ok', ['ghost', 'sk'])).user('ghost')).toEqual({ state: 'pending', url: null, apiKey: null });
  });
});

describe('FileProvisioning', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'portal-prov-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads metamcp-clients.json and treats a missing file as not yet provisioned', async () => {
    const p = new FileProvisioning(dir);
    expect(await p.read()).toBeNull();
    writeFileSync(join(dir, 'metamcp-clients.json'), JSON.stringify(clients(1, 'ok', ['anna', 'sk'])));
    expect((await p.read())?.users[0]?.apiKey).toBe('sk');
  });

  it('a half-written or foreign file is reported as a failed run, not thrown', async () => {
    writeFileSync(join(dir, 'metamcp-clients.json'), '{"users": [');
    expect(await new FileProvisioning(dir).read()).toMatchObject({ status: 'failed', users: [] });
    writeFileSync(join(dir, 'metamcp-clients.json'), '{"users": "nope"}');
    expect(await new FileProvisioning(dir).read()).toMatchObject({ status: 'failed', users: [] });
  });
});
