import { describe, expect, it } from 'vitest';
import { checkSmtpHost, isPublicIp } from './smtp-guard.ts';

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  const a = map[host];
  if (!a) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return a;
};

describe('isPublicIp', () => {
  it.each(['8.8.8.8', '185.12.64.1', '2a00:1450:4001:80b::200e'])('public: %s', (ip) => expect(isPublicIp(ip)).toBe(true));
  it.each(['10.0.0.1', '172.18.0.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '255.255.255.255'])('not public: %s', (ip) => expect(isPublicIp(ip)).toBe(false));
});

describe('checkSmtpHost (audit L1)', () => {
  const lookup = resolver({ 'smtp.example.com': ['93.184.216.34'], 'metamcp-db': ['10.234.3.2'], 'mixed.example.com': ['93.184.216.34', '10.0.0.5'], 'relay.lan': ['192.168.1.10'] });

  it('accepts a host that resolves only to public addresses and returns the address to connect to', async () => {
    expect(await checkSmtpHost('smtp.example.com', [], lookup)).toEqual({ ok: true, address: '93.184.216.34' });
  });

  it('refuses internal names, private IP literals and hosts with any private address', async () => {
    expect(await checkSmtpHost('metamcp-db', [], lookup)).toEqual({ ok: false, reason: 'private' });
    expect(await checkSmtpHost('10.0.0.1', [], lookup)).toEqual({ ok: false, reason: 'private' });
    expect(await checkSmtpHost('mixed.example.com', [], lookup)).toEqual({ ok: false, reason: 'private' });
  });

  it('reports unresolvable hosts', async () => {
    expect(await checkSmtpHost('nope.example.com', [], lookup)).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('allows a private host only when it is explicitly allow-listed (SMTP_ALLOWED_HOSTS)', async () => {
    expect(await checkSmtpHost('relay.lan', ['relay.lan'], lookup)).toEqual({ ok: true, address: '192.168.1.10' });
    expect(await checkSmtpHost('RELAY.lan', ['relay.lan'], lookup)).toEqual({ ok: true, address: '192.168.1.10' });
  });
});
