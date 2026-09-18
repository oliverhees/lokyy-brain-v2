// SMTP targets must be public mail servers (audit L1): an admin-entered host must not turn the portal
// into a port scanner for internal services or send SMTP credentials to them. Internal relays can be
// allowed explicitly with SMTP_ALLOWED_HOSTS. The resolved address is used for the connection, so a
// later DNS answer cannot redirect it (TLS still verifies the hostname).
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked.check(ip, 'ipv4');
  if (v !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicIp(mapped[1]!);
  // only global unicast (2000::/3) counts as public
  return /^[23]/.test(ip) && !blocked.check(ip, 'ipv6');
}

export type Resolve = (host: string) => Promise<string[]>;
const defaultResolve: Resolve = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type HostCheck = { ok: true; address: string } | { ok: false; reason: 'private' | 'unresolvable' };

export async function checkSmtpHost(host: string, allowed: readonly string[], resolve: Resolve = defaultResolve): Promise<HostCheck> {
  const name = host.toLowerCase();
  let addresses: string[];
  try {
    addresses = isIP(name) ? [name] : await resolve(name);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };
  if (allowed.includes(name)) return { ok: true, address: addresses[0]! };
  return addresses.every(isPublicIp) ? { ok: true, address: addresses[0]! } : { ok: false, reason: 'private' };
}
