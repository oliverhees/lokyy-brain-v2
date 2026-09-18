// Portal configuration from the environment (Coolify magic variables in production; contract with
// LBV2-27 in docs/setup-portal.md).
import { parseSlots } from './slots.ts';

export interface PortalConfig {
  port: number;
  domain: string;
  slots: string[];
  /** lokyy-state volume (read-write, portal only): state.json, secrets.json, users.json, audit.log */
  stateDir: string;
  /** lokyy-provision volume (read-only): metamcp-clients.json written by the provisioning watcher */
  provisionDir: string;
  /** Package name of the deployment (LOKYY_PACKAGE), shown to admins; null when unset */
  package: string | null;
  /** Value Traefik sets as X-Vault-Proxy-Secret on the app.<domain> router */
  proxySecret: string;
  publicOrigin: string;
  staticDir: string;
  authentik: { url: string; publicUrl: string; token: string };
  mcpPublicBase: string;
  vaultAdminUrl: string;
  inviteValidity: string;
  /** Public URL of <host>.<domain>: LOKYY_PUBLIC_SCHEME (https) and optional LOKYY_PUBLIC_PORT */
  siteUrl: (host: string) => string;
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
  const inviteValidity = env['PORTAL_INVITE_VALIDITY'] ?? 'days=7';
  if (!/^(days|hours)=\d{1,2}$/.test(inviteValidity)) throw new Error('PORTAL_INVITE_VALIDITY must look like days=7 or hours=48');
  const scheme = env['LOKYY_PUBLIC_SCHEME'] ?? 'https';
  if (scheme !== 'https' && scheme !== 'http') throw new Error('LOKYY_PUBLIC_SCHEME must be https or http');
  const port = env['LOKYY_PUBLIC_PORT'] ?? '';
  if (port && !/^\d{1,5}$/.test(port)) throw new Error('LOKYY_PUBLIC_PORT must be a port number');
  const site = (host: string) => `${scheme}://${host}.${domain}${port ? `:${port}` : ''}`;
  const pkg = env['LOKYY_PACKAGE']?.trim();
  return {
    port: Number(env['PORT'] ?? 3000),
    domain,
    slots: parseSlots(env['LOKYY_SLOTS']),
    stateDir: env['LOKYY_STATE_DIR'] ?? '/state',
    provisionDir: env['LOKYY_PROVISION_DIR'] ?? '/provision',
    package: pkg ? pkg.slice(0, 100) : null,
    proxySecret,
    publicOrigin: env['PORTAL_PUBLIC_ORIGIN'] ?? site('app'),
    staticDir: env['PORTAL_STATIC_DIR'] ?? new URL('../../dist/client', import.meta.url).pathname,
    authentik: { url: env['AUTHENTIK_URL'] ?? 'http://authentik-server:9000', publicUrl: env['AUTHENTIK_PUBLIC_URL'] ?? site('auth'), token: req('AUTHENTIK_API_TOKEN') },
    mcpPublicBase: env['METAMCP_PUBLIC_BASE'] ?? site('mcp'),
    vaultAdminUrl: req('VAULT_ADMIN_URL'),
    inviteValidity,
    siteUrl: site,
  };
}
