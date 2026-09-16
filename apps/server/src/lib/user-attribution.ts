import { userInfo } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import { isValidUsername, USERNAME_MAX_LENGTH } from '@mindbase/core';

/** The attribution header (client-sent or proxy-set) is not a valid contributor username. */
export class InvalidUserError extends Error {
  constructor(message = 'Invalid X-Mindbase-User header') { super(message); }
}

/** Default proxy identity header (Authentik forward-auth, copied upstream by Traefik). */
export const DEFAULT_IDENTITY_HEADER = 'x-authentik-username';
/** Attribution used in guarded mode when the proxy did not supply an identity. */
export const UNKNOWN_USER = 'unknown';
/** Last-resort name when an OS username sanitizes to nothing. */
const FALLBACK_OS_USER = 'user';

export interface ResolveUserOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to os.userInfo().username. */
  osUsername?: () => string;
}

type HeaderBag = { headers: Record<string, string | string[] | undefined> };

let warnedMissingIdentity = false;

/**
 * Deterministically maps an arbitrary name (e.g. an OS account like
 * `oliver@corp` or `John Smith`) onto the contributor-username alphabet.
 */
export function sanitizeUsername(name: string): string {
  let s = name.normalize('NFC').replace(/[^\p{L}\p{N}_.-]/gu, '_');
  s = s.replace(/\.{2,}/g, '.').replace(/^[.-]+/, '').slice(0, USERNAME_MAX_LENGTH);
  return isValidUsername(s) ? s : FALLBACK_OS_USER;
}

function identityHeaderName(env: NodeJS.ProcessEnv): string {
  return env['VAULT_IDENTITY_HEADER']?.trim().toLowerCase() || DEFAULT_IDENTITY_HEADER;
}

/** Guarded mode = the proxy shared-secret guard is active (see proxy-secret.ts). */
function isGuarded(env: NodeJS.ProcessEnv): boolean {
  return !!env['VAULT_PROXY_SECRET'];
}

function osFallback(osUsername: () => string): string {
  try {
    return sanitizeUsername(osUsername());
  } catch {
    return FALLBACK_OS_USER;
  }
}

/**
 * The attributed user. The name becomes a directory under
 * sources/contributors/, so an invalid name throws rather than silently
 * falling back (which would misattribute the write).
 *
 * - Guarded mode (VAULT_PROXY_SECRET set): only the proxy-set identity header
 *   (VAULT_IDENTITY_HEADER, default x-authentik-username) counts; a client
 *   X-Mindbase-User is ignored. Missing identity → UNKNOWN_USER.
 * - Otherwise: X-Mindbase-User, or the sanitized OS user when absent/empty.
 */
export function resolveUser(req: HeaderBag, options: ResolveUserOptions = {}): string {
  const env = options.env ?? process.env;

  if (isGuarded(env)) {
    const header = identityHeaderName(env);
    const raw = req.headers[header];
    if (raw === undefined || raw === '') {
      if (!warnedMissingIdentity) {
        warnedMissingIdentity = true;
        console.warn(`[user-attribution] proxy identity header "${header}" missing; attributing to "${UNKNOWN_USER}"`);
      }
      return UNKNOWN_USER;
    }
    if (typeof raw !== 'string' || !isValidUsername(raw)) throw new InvalidUserError('Invalid identity header');
    return raw;
  }

  const raw = req.headers['x-mindbase-user'];
  if (typeof raw === 'string' && raw.length > 0) {
    if (!isValidUsername(raw)) throw new InvalidUserError();
    return raw;
  }
  return osFallback(options.osUsername ?? (() => userInfo().username));
}

/** Router middleware: answers 400 for an invalid attribution header before any handler runs. */
export function rejectInvalidUser(req: Request, res: Response, next: NextFunction): void {
  try {
    resolveUser(req);
  } catch (e) {
    if (!(e instanceof InvalidUserError)) throw e;
    res.status(400).json({ error: e.message });
    return;
  }
  next();
}
