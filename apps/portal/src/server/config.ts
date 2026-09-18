// Portal configuration from the environment (Coolify magic variables in production; names agreed with
// LBV2-27, see docs/setup-portal.md).
import { parseSlots } from './slots.ts';

export interface PortalConfig {
  port: number;
  domain: string;
  slots: string[];
  /** lokyy-state volume (read-write, portal only) */
  stateDir: string;
  /** LOKYY_PACKAGE, shown to admins; null when unset */
  package: string | null;
  /** Value Traefik sets as X-Vault-Proxy-Secret on the app.<domain> router */
  proxySecret: string;
  /** SMTP hosts allowed although they resolve to private addresses (SMTP_ALLOWED_HOSTS) */
  smtpAllowedHosts: string[];
  publicOrigin: string;
  staticDir: string;
  /** The portal holds no Authentik token: authentik-gate does, and only lets it manage its employees */
  authentik: { gateUrl: string; gateSecret: string; publicUrl: string };
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
  const proxySecret = req('VAULT_PROXY_SECRET');
  if (proxySecret.length < 32 || proxySecret.trim() !== proxySecret) throw new Error('VAULT_PROXY_SECRET must be at least 32 characters without surrounding whitespace');
  const gateSecret = req('AUTHENTIK_GATE_SECRET');
  if (gateSecret.length < 32 || gateSecret.trim() !== gateSecret) throw new Error('AUTHENTIK_GATE_SECRET must be at least 32 characters without surrounding whitespace');
  const inviteValidity = env['PORTAL_INVITE_VALIDITY'] ?? 'days=7';
  const iv = /^(days|hours)=(\d{1,3})$/.exec(inviteValidity);
  // Invitation links are login credentials: at most 14 days.
  if (!iv || Number(iv[2]) < 1 || Number(iv[2]) * (iv[1] === 'days' ? 24 : 1) > 14 * 24) {
    throw new Error('PORTAL_INVITE_VALIDITY must be days=1…14 or hours=1…336');
  }
  const scheme = env['LOKYY_PUBLIC_SCHEME'] ?? 'https';
  if (scheme !== 'https' && scheme !== 'http') throw new Error('LOKYY_PUBLIC_SCHEME must be https or http');
  const port = env['LOKYY_PUBLIC_PORT'] ?? '';
  if (port && !/^\d{1,5}$/.test(port)) throw new Error('LOKYY_PUBLIC_PORT must be a port number');
  const metamcpUrl = env['METAMCP_URL'] ?? 'http://metamcp:12008';
  return {
    port: Number(env['PORT'] ?? 3000),
    domain,
    slots: parseSlots(env['LOKYY_SLOTS']),
    stateDir: env['LOKYY_STATE_DIR'] ?? '/state',
    package: env['LOKYY_PACKAGE']?.trim().slice(0, 100) || null,
    proxySecret,
    smtpAllowedHosts: (env['SMTP_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    publicOrigin: env['PORTAL_PUBLIC_ORIGIN'] ?? `${scheme}://app.${domain}${port ? `:${port}` : ''}`,
    staticDir: env['PORTAL_STATIC_DIR'] ?? new URL('../../dist/client', import.meta.url).pathname,
    authentik: {
      gateUrl: env['AUTHENTIK_GATE_URL'] ?? 'http://authentik-gate:8080',
      gateSecret,
      publicUrl: env['AUTHENTIK_PUBLIC_URL'] ?? `${scheme}://auth.${domain}${port ? `:${port}` : ''}`,
    },
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
