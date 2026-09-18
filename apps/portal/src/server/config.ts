// Portal configuration from the environment (Coolify magic variables in production).
import { parseSlots } from './slots.ts';

export interface PortalConfig {
  port: number;
  domain: string;
  slots: string[];
  stateDir: string;
  proxySecret: string;
  publicOrigin: string;
  staticDir: string;
  authentik: { url: string; publicUrl: string; token: string };
  metamcp: { url: string; databaseUrl: string; publicBase: string; origin: string };
  vaultAdminUrl: string;
  inviteValidity: string;
  /** Public URL of <host>.<domain>: LOKYY_PUBLIC_SCHEME (https) and optional LOKYY_PUBLIC_PORT */
  siteUrl: (host: string) => string;
  /** Whole environment: MCP_TOKEN_* / MCP_READONLY_TOKEN_* are looked up by name during provisioning */
  env: Record<string, string | undefined>;
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function loadConfig(env: Record<string, string | undefined>): PortalConfig {
  const req = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const domain = req('LOKYY_DOMAIN');
  if (!DOMAIN_RE.test(domain)) throw new Error('LOKYY_DOMAIN must be a bare domain like example.com');
  const proxySecret = req('PORTAL_PROXY_SECRET');
  if (proxySecret.length < 32 || proxySecret.trim() !== proxySecret) throw new Error('PORTAL_PROXY_SECRET must be at least 32 characters without surrounding whitespace');
  const inviteValidity = env['PORTAL_INVITE_VALIDITY'] ?? 'days=7';
  if (!/^(days|hours)=\d{1,2}$/.test(inviteValidity)) throw new Error('PORTAL_INVITE_VALIDITY must look like days=7 or hours=48');
  const scheme = env['LOKYY_PUBLIC_SCHEME'] ?? 'https';
  if (scheme !== 'https' && scheme !== 'http') throw new Error('LOKYY_PUBLIC_SCHEME must be https or http');
  const port = env['LOKYY_PUBLIC_PORT'] ?? '';
  if (port && !/^\d{1,5}$/.test(port)) throw new Error('LOKYY_PUBLIC_PORT must be a port number');
  const metamcpUrl = env['METAMCP_URL'] ?? 'http://metamcp:12008';
  return {
    port: Number(env['PORT'] ?? 3000),
    domain,
    slots: parseSlots(env['LOKYY_SLOTS']),
    stateDir: env['PORTAL_STATE_DIR'] ?? '/state',
    proxySecret,
    publicOrigin: env['PORTAL_PUBLIC_ORIGIN'] ?? `${scheme}://app.${domain}${port ? `:${port}` : ''}`,
    staticDir: env['PORTAL_STATIC_DIR'] ?? new URL('../../dist/client', import.meta.url).pathname,
    authentik: { url: env['AUTHENTIK_URL'] ?? 'http://authentik-server:9000', publicUrl: env['AUTHENTIK_PUBLIC_URL'] ?? `${scheme}://auth.${domain}${port ? `:${port}` : ''}`, token: req('AUTHENTIK_API_TOKEN') },
    metamcp: {
      url: metamcpUrl,
      databaseUrl: req('METAMCP_DATABASE_URL'),
      publicBase: env['METAMCP_PUBLIC_BASE'] ?? `${scheme}://mcp.${domain}${port ? `:${port}` : ''}`,
      origin: env['METAMCP_ORIGIN'] ?? env['METAMCP_PUBLIC_BASE'] ?? `https://mcp.${domain}`,
    },
    vaultAdminUrl: req('VAULT_ADMIN_URL'),
    inviteValidity,
    siteUrl: (host) => `${scheme}://${host}.${domain}${port ? `:${port}` : ''}`,
    env,
  };
}
