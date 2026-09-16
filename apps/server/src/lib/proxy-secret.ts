// Self-hosted deployments put the vault behind an authenticating reverse proxy
// (Traefik + Authentik). The server itself has no authentication, so any other
// container that can reach it directly would bypass the proxy. When
// VAULT_PROXY_SECRET is set, every request must carry the secret the proxy
// injects; everything else gets 403.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export const PROXY_SECRET_HEADER = 'x-vault-proxy-secret';
export const MIN_PROXY_SECRET_LENGTH = 32;

/**
 * Reads VAULT_PROXY_SECRET; undefined when unset, throws when too short.
 * With VAULT_REQUIRE_PROXY_SECRET set (the self-hosted image does this), a
 * missing secret aborts startup instead of silently disabling the guard.
 */
export function readProxySecret(env: NodeJS.ProcessEnv): string | undefined {
  const secret = env['VAULT_PROXY_SECRET'];
  if (!secret) {
    if (env['VAULT_REQUIRE_PROXY_SECRET']) {
      throw new Error('VAULT_PROXY_SECRET is required (VAULT_REQUIRE_PROXY_SECRET is set)');
    }
    return undefined;
  }
  if (secret.length < MIN_PROXY_SECRET_LENGTH) {
    throw new Error(`VAULT_PROXY_SECRET must be at least ${MIN_PROXY_SECRET_LENGTH} characters`);
  }
  return secret;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function proxySecretGuard(secret: string | undefined): RequestHandler {
  if (!secret) return (_req, _res, next) => next();
  const expected = digest(secret);

  return (req, res, next) => {
    const given = req.headers[PROXY_SECRET_HEADER];
    // Node joins duplicated custom headers with ", " — a joined value never matches.
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), expected)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    delete req.headers[PROXY_SECRET_HEADER];
    next();
  };
}
