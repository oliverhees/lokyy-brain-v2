// Identity and group headers set by the authenticating reverse proxy
// (Traefik forward-auth → Authentik). They are only trusted in guarded mode
// (VAULT_PROXY_SECRET set), where every request provably came through the
// proxy, and the proxy overwrites client values via authResponseHeaders.
import type { RequestHandler } from 'express';

export const DEFAULT_IDENTITY_HEADER = 'x-authentik-username';
/** Authentik sends groups pipe-separated (`a|b`); commas are accepted too. */
export const DEFAULT_GROUPS_HEADER = 'x-authentik-groups';

/** Headers a client sets itself, or that the server consumes for other purposes. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'x-mindbase-user', 'x-vault-proxy-secret', 'authorization', 'cookie', 'host',
  'content-type', 'content-length', 'origin', 'referer', 'user-agent',
]);

type HeaderBag = { headers: Record<string, string | string[] | undefined> };

function headerName(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase() || fallback;
}

export function identityHeaderName(env: NodeJS.ProcessEnv): string {
  return headerName(env['VAULT_IDENTITY_HEADER'], DEFAULT_IDENTITY_HEADER);
}

export function groupsHeaderName(env: NodeJS.ProcessEnv): string {
  return headerName(env['VAULT_GROUPS_HEADER'], DEFAULT_GROUPS_HEADER);
}

/** Guarded mode = the proxy shared-secret guard is active (see proxy-secret.ts). */
export function isGuarded(env: NodeJS.ProcessEnv): boolean {
  return !!env['VAULT_PROXY_SECRET'];
}

/** Startup check: throws when a trusted header is configured to a client-controlled or reserved name. */
export function assertTrustedHeaderConfig(env: NodeJS.ProcessEnv): void {
  const identity = identityHeaderName(env);
  const groups = groupsHeaderName(env);
  for (const [variable, name] of [['VAULT_IDENTITY_HEADER', identity], ['VAULT_GROUPS_HEADER', groups]] as const) {
    if (RESERVED_HEADERS.has(name)) {
      throw new Error(`${variable} must not be the reserved or client-controlled header "${name}"`);
    }
  }
  if (identity === groups) {
    throw new Error('VAULT_IDENTITY_HEADER and VAULT_GROUPS_HEADER must be different (reserved)');
  }
}

export function parseGroups(raw: string | string[] | undefined): string[] {
  // A duplicated header arrives as an array: ambiguous, so it grants nothing.
  if (typeof raw !== 'string') return [];
  return raw.split(/[|,]/).map((g) => g.trim()).filter((g) => g.length > 0);
}

/**
 * May this request change server configuration? Always outside guarded mode.
 * In guarded mode: only members of VAULT_ADMIN_GROUPS; unset → nobody (fail closed).
 */
export function isConfigAdmin(req: HeaderBag, env: NodeJS.ProcessEnv): boolean {
  if (!isGuarded(env)) return true;
  const admins = new Set(parseGroups(env['VAULT_ADMIN_GROUPS']));
  if (admins.size === 0) return false;
  return parseGroups(req.headers[groupsHeaderName(env)]).some((g) => admins.has(g));
}

/** Middleware for config-mutating routers: GET/HEAD pass, every other method needs isConfigAdmin. */
export function requireConfigAdmin(env: NodeJS.ProcessEnv): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || isConfigAdmin(req, env)) { next(); return; }
    res.status(403).json({ error: 'Forbidden' });
  };
}

/** Like requireConfigAdmin, but for every method (e.g. the Google OAuth callback, a GET that writes tokens). */
export function requireConfigAdminAlways(env: NodeJS.ProcessEnv): RequestHandler {
  return (req, res, next) => {
    if (isConfigAdmin(req, env)) { next(); return; }
    res.status(403).json({ error: 'Forbidden' });
  };
}
