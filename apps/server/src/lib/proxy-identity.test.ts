import { describe, it, expect } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import {
  assertTrustedHeaderConfig, identityHeaderName, groupsHeaderName, parseGroups, isConfigAdmin, requireConfigAdmin,
} from './proxy-identity';

const SECRET = 'x'.repeat(32);
const guarded = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ VAULT_PROXY_SECRET: SECRET, ...extra });

describe('trusted header configuration (LBV2-9)', () => {
  it('defaults the header names', () => {
    expect(identityHeaderName({})).toBe('x-authentik-username');
    expect(groupsHeaderName({})).toBe('x-authentik-groups');
    expect(groupsHeaderName({ VAULT_GROUPS_HEADER: ' X-Groups ' })).toBe('x-groups');
  });

  it.each([
    ['VAULT_IDENTITY_HEADER', 'x-mindbase-user'],
    ['VAULT_IDENTITY_HEADER', 'X-Vault-Proxy-Secret'],
    ['VAULT_GROUPS_HEADER', 'x-mindbase-user'],
    ['VAULT_GROUPS_HEADER', ' x-vault-proxy-secret '],
    ['VAULT_IDENTITY_HEADER', 'cookie'],
    ['VAULT_GROUPS_HEADER', 'authorization'],
  ])('refuses %s=%j at startup', (name, value) => {
    expect(() => assertTrustedHeaderConfig({ [name]: value })).toThrow(/reserved|client-controlled/);
  });

  it('refuses identical identity and groups headers', () => {
    expect(() => assertTrustedHeaderConfig({ VAULT_IDENTITY_HEADER: 'x-a', VAULT_GROUPS_HEADER: 'X-A' })).toThrow();
  });

  it('accepts defaults and custom proxy headers', () => {
    expect(() => assertTrustedHeaderConfig({})).not.toThrow();
    expect(() => assertTrustedHeaderConfig({ VAULT_IDENTITY_HEADER: 'x-forwarded-user', VAULT_GROUPS_HEADER: 'x-forwarded-groups' })).not.toThrow();
  });
});

describe('admin groups (LBV2-9)', () => {
  it('parses Authentik pipe-separated groups only', () => {
    expect(parseGroups('lokyy-admins|vault-firma-admin')).toEqual(['lokyy-admins', 'vault-firma-admin']);
    expect(parseGroups(' a | b|| c ')).toEqual(['a', 'b', 'c']);
    expect(parseGroups('staff,vault-admins')).toEqual(['staff,vault-admins']);
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(['a', 'b'])).toEqual([]);
  });

  it('treats a Node-joined duplicate header (", ") as no groups (fail closed)', () => {
    expect(parseGroups('staff, vault-admins')).toEqual([]);
    expect(parseGroups('staff|x, vault-admins')).toEqual([]);
    const env = guarded({ VAULT_ADMIN_GROUPS: 'vault-admins' });
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'staff, vault-admins' } }, env)).toBe(false);
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'staff,vault-admins' } }, env)).toBe(false);
  });

  it('is always admin outside guarded mode', () => {
    expect(isConfigAdmin({ headers: {} }, {})).toBe(true);
  });

  it('fails closed in guarded mode without VAULT_ADMIN_GROUPS', () => {
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'lokyy-admins' } }, guarded())).toBe(false);
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'lokyy-admins' } }, guarded({ VAULT_ADMIN_GROUPS: ' , ' }))).toBe(false);
  });

  it('requires membership in one of VAULT_ADMIN_GROUPS (exact match)', () => {
    const env = guarded({ VAULT_ADMIN_GROUPS: 'lokyy-admins, vault-firma-admin' });
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'staff|vault-firma-admin' } }, env)).toBe(true);
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'staff|vault-firma-admins' } }, env)).toBe(false);
    expect(isConfigAdmin({ headers: {} }, env)).toBe(false);
    expect(isConfigAdmin({ headers: { 'x-mindbase-user': 'lokyy-admins' } }, env)).toBe(false);
  });

  it('honours VAULT_GROUPS_HEADER', () => {
    const env = guarded({ VAULT_ADMIN_GROUPS: 'admins', VAULT_GROUPS_HEADER: 'x-forwarded-groups' });
    expect(isConfigAdmin({ headers: { 'x-forwarded-groups': 'admins', 'x-authentik-groups': 'nope' } }, env)).toBe(true);
    expect(isConfigAdmin({ headers: { 'x-authentik-groups': 'admins' } }, env)).toBe(false);
  });

  function app(env: NodeJS.ProcessEnv): express.Application {
    const a = express();
    const r = Router();
    r.all('*', (_req, res) => { res.json({ reached: true }); });
    a.use('/api/config', requireConfigAdmin(env), r);
    return a;
  }

  it('middleware lets GET through and answers 403 for writes by non-admins', async () => {
    const env = guarded({ VAULT_ADMIN_GROUPS: 'admins' });
    expect((await request(app(env)).get('/api/config')).status).toBe(200);
    for (const m of ['put', 'post', 'delete', 'patch'] as const) {
      const res = await request(app(env))[m]('/api/config/test').set('x-authentik-groups', 'staff');
      expect(res.status, m).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    }
    const ok = await request(app(env)).put('/api/config').set('x-authentik-groups', 'staff|admins');
    expect(ok.status).toBe(200);
  });

  it('middleware passes writes outside guarded mode', async () => {
    expect((await request(app({})).put('/api/config')).status).toBe(200);
  });
});
