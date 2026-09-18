import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { HttpVaultAdmin } from './vault-admin.ts';
import { smtpTransportOptions } from './mailer.ts';

const base: Record<string, string> = {
  LOKYY_DOMAIN: 'example.com',
  LOKYY_SLOTS: 'v01,v02',
  VAULT_PROXY_SECRET: 's'.repeat(40),
  AUTHENTIK_API_TOKEN: 't'.repeat(40),
  VAULT_ADMIN_URL: 'http://lokyy-traefik:8090',
};

describe('loadConfig', () => {
  it('derives defaults from the domain', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000, domain: 'example.com', slots: ['v01', 'v02'], stateDir: '/state', provisionDir: '/provision', package: null,
      publicOrigin: 'https://app.example.com',
      authentik: { url: 'http://authentik-server:9000', publicUrl: 'https://auth.example.com' },
      mcpPublicBase: 'https://mcp.example.com',
      inviteValidity: 'days=7',
    });
  });

  it('reads the LBV2-27 env names (LOKYY_STATE_DIR, LOKYY_PROVISION_DIR, LOKYY_PACKAGE)', () => {
    const c = loadConfig({ ...base, LOKYY_STATE_DIR: '/var/lib/lokyy-state', LOKYY_PROVISION_DIR: '/var/lib/lokyy-provision', LOKYY_PACKAGE: 'team-10' });
    expect(c).toMatchObject({ stateDir: '/var/lib/lokyy-state', provisionDir: '/var/lib/lokyy-provision', package: 'team-10' });
  });

  it.each(['LOKYY_DOMAIN', 'LOKYY_SLOTS', 'VAULT_PROXY_SECRET', 'AUTHENTIK_API_TOKEN', 'VAULT_ADMIN_URL'])('requires %s', (name) => {
    const { [name]: _, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(name);
  });

  it('rejects a short proxy secret and a bad domain', () => {
    expect(() => loadConfig({ ...base, VAULT_PROXY_SECRET: 'short' })).toThrow(/VAULT_PROXY_SECRET/);
    expect(() => loadConfig({ ...base, LOKYY_DOMAIN: 'https://example.com' })).toThrow(/LOKYY_DOMAIN/);
  });

  it('builds public URLs from scheme and port (local stacks)', () => {
    const c = loadConfig({ ...base, LOKYY_PUBLIC_SCHEME: 'http', LOKYY_PUBLIC_PORT: '18380' });
    expect(c.siteUrl('v01')).toBe('http://v01.example.com:18380');
    expect(c.publicOrigin).toBe('http://app.example.com:18380');
    expect(c.authentik.publicUrl).toBe('http://auth.example.com:18380');
    expect(c.mcpPublicBase).toBe('http://mcp.example.com:18380');
    expect(loadConfig(base).siteUrl('firma')).toBe('https://firma.example.com');
    expect(() => loadConfig({ ...base, LOKYY_PUBLIC_SCHEME: 'ftp' })).toThrow(/SCHEME/);
  });

  it('accepts only day/hour invitation validities', () => {
    expect(loadConfig({ ...base, PORTAL_INVITE_VALIDITY: 'days=3' }).inviteValidity).toBe('days=3');
    expect(() => loadConfig({ ...base, PORTAL_INVITE_VALIDITY: 'weeks=99' })).toThrow(/PORTAL_INVITE_VALIDITY/);
  });
});

describe('HttpVaultAdmin', () => {
  it('PUTs key and route (ruleId) to /<vault>/api/config of the internal admin entrypoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const va = new HttpVaultAdmin('http://lokyy-traefik:8090/', async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{"ok":true}', { status: 200 });
    });
    await va.configureLlm('v01', { apiKey: 'sk-1234567890', ruleId: 'r-1' });
    await va.configureLlm('firma', { apiKey: 'sk-1234567890', ruleId: 'r-1', model: 'mistral/x' });
    expect(calls[0]!.url).toBe('http://lokyy-traefik:8090/v01/api/config');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: 'openai', baseUrl: 'https://api.eurouter.ai/api/v1', apiKey: 'sk-1234567890', ruleId: 'r-1' });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ ruleId: 'r-1', model: 'mistral/x' });
    expect(calls[1]!.url).toBe('http://lokyy-traefik:8090/firma/api/config');
  });

  it('throws on a refused config without echoing the body', async () => {
    const va = new HttpVaultAdmin('http://x', async () => new Response('{"ok":false,"error":"sk-1234567890"}', { status: 400 }));
    const err = await va.configureLlm('v01', { apiKey: 'sk-1234567890', ruleId: 'r' }).catch((e: Error) => e);
    expect(String(err)).toContain('400');
    expect(String(err)).not.toContain('sk-1234567890');
  });

  it('refuses vault names that could change the path', async () => {
    const va = new HttpVaultAdmin('http://x', async () => new Response('{}'));
    await expect(va.configureLlm('../v01', { apiKey: 'k', ruleId: 'r' })).rejects.toThrow(/vault/);
  });
});

describe('smtpTransportOptions', () => {
  it('disables file and URL access and passes auth only when a user is set', () => {
    const o = smtpTransportOptions({ settings: { host: 'h.example.com', port: 587, secure: false, username: 'u', from: 'a@example.com', updatedAt: '' }, password: 'pw' });
    expect(o).toMatchObject({ host: 'h.example.com', port: 587, secure: false, auth: { user: 'u', pass: 'pw' }, disableFileAccess: true, disableUrlAccess: true, requireTLS: true });
    const anon = smtpTransportOptions({ settings: { host: 'h', port: 25, secure: false, username: '', from: 'a@example.com', updatedAt: '' }, password: undefined });
    expect(anon.auth).toBeUndefined();
  });
});
