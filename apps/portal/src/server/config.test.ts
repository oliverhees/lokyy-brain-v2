import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { HttpVaultAdmin } from './vault-admin.ts';
import { createMailer, smtpTransportOptions } from './mailer.ts';

const base: Record<string, string> = {
  LOKYY_DOMAIN: 'example.com',
  LOKYY_SLOTS: 'v01,v02',
  VAULT_PROXY_SECRET: 's'.repeat(40),
  AUTHENTIK_GATE_SECRET: 'g'.repeat(40),
  METAMCP_DATABASE_URL: 'postgresql://metamcp:pw@metamcp-db:5432/metamcp',
  VAULT_ADMIN_URL: 'http://lokyy-traefik:8090',
};

describe('loadConfig', () => {
  it('derives defaults from the domain', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000, domain: 'example.com', slots: ['v01', 'v02'], stateDir: '/state', package: null, smtpAllowedHosts: [],
      publicOrigin: 'https://app.example.com',
      authentik: { gateUrl: 'http://authentik-gate:8080', publicUrl: 'https://auth.example.com' },
      metamcp: { url: 'http://metamcp:12008', publicBase: 'https://mcp.example.com' },
      inviteValidity: 'days=7',
    });
  });

  it('reads the LBV2-27 env names', () => {
    const c = loadConfig({ ...base, LOKYY_STATE_DIR: '/var/lib/lokyy-state', LOKYY_PACKAGE: 'team-10', SMTP_ALLOWED_HOSTS: 'mail.intern, relay.lan' });
    expect(c).toMatchObject({ stateDir: '/var/lib/lokyy-state', package: 'team-10', smtpAllowedHosts: ['mail.intern', 'relay.lan'] });
  });

  it.each(['LOKYY_DOMAIN', 'LOKYY_SLOTS', 'VAULT_PROXY_SECRET', 'AUTHENTIK_GATE_SECRET', 'METAMCP_DATABASE_URL', 'VAULT_ADMIN_URL'])('requires %s', (name) => {
    const { [name]: _, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(name);
  });

  it('holds no Authentik token: it only knows the gate and its shared secret', () => {
    const c = loadConfig({ ...base, AUTHENTIK_API_TOKEN: 'leftover', AUTHENTIK_GATE_URL: 'http://gate:9999' });
    expect(c.authentik).toEqual({ gateUrl: 'http://gate:9999', publicUrl: 'https://auth.example.com', gateSecret: 'g'.repeat(40) });
    expect(() => loadConfig({ ...base, AUTHENTIK_GATE_SECRET: 'short' })).toThrow(/AUTHENTIK_GATE_SECRET/);
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
    expect(c.metamcp.publicBase).toBe('http://mcp.example.com:18380');
    expect(loadConfig(base).siteUrl('firma')).toBe('https://firma.example.com');
    expect(() => loadConfig({ ...base, LOKYY_PUBLIC_SCHEME: 'ftp' })).toThrow(/SCHEME/);
  });

  it('accepts only day/hour invitation validities up to 14 days', () => {
    expect(loadConfig({ ...base, PORTAL_INVITE_VALIDITY: 'days=3' }).inviteValidity).toBe('days=3');
    expect(loadConfig({ ...base, PORTAL_INVITE_VALIDITY: 'days=14' }).inviteValidity).toBe('days=14');
    expect(loadConfig({ ...base, PORTAL_INVITE_VALIDITY: 'hours=48' }).inviteValidity).toBe('hours=48');
    for (const bad of ['weeks=99', 'days=15', 'days=99', 'hours=337', 'days=0']) {
      expect(() => loadConfig({ ...base, PORTAL_INVITE_VALIDITY: bad })).toThrow(/PORTAL_INVITE_VALIDITY/);
    }
  });
});

describe('HttpVaultAdmin', () => {
  it('PUTs key and route (ruleId, no model) to /<vault>/api/config of the internal admin entrypoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const va = new HttpVaultAdmin('http://lokyy-traefik:8090/', async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{"ok":true}', { status: 200 });
    });
    await va.configureLlm('v01', { apiKey: 'sk-1234567890', ruleId: 'r-1', ruleName: 'EU Standard' });
    expect(calls[0]!.url).toBe('http://lokyy-traefik:8090/v01/api/config');
    expect(calls[0]!.init.method).toBe('PUT');
    // vault config API of LBV2-30: route only (ruleId, ruleName for display), no model
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: 'openai', baseUrl: 'https://api.eurouter.ai/api/v1', apiKey: 'sk-1234567890', ruleId: 'r-1', ruleName: 'EU Standard' });
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
  it('connects to the checked address, verifies TLS for the hostname, no file/URL access, auth only with a user', () => {
    const o = smtpTransportOptions({ settings: { host: 'h.example.com', port: 587, secure: false, username: 'u', from: 'a@example.com', updatedAt: '' }, password: 'pw' }, '93.184.216.34');
    expect(o).toMatchObject({ host: '93.184.216.34', tls: { servername: 'h.example.com' }, port: 587, secure: false, auth: { user: 'u', pass: 'pw' },
      disableFileAccess: true, disableUrlAccess: true, requireTLS: true });
    const anon = smtpTransportOptions({ settings: { host: 'h', port: 25, secure: false, username: '', from: 'a@example.com', updatedAt: '' }, password: undefined }, '93.184.216.34');
    expect(anon.auth).toBeUndefined();
  });
});

describe('createMailer', () => {
  it('refuses to send to a host that resolves to a private address', async () => {
    const m = createMailer({ settings: { host: 'internal', port: 25, secure: false, username: '', from: 'a@example.com', updatedAt: '' }, password: undefined },
      { allowed: [], resolve: async () => ['10.0.0.9'] })!;
    await expect(m.send({ to: 'x@example.com', subject: 's', text: 't' })).rejects.toThrow(/private/);
  });
});
