import { userInfo } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import { isValidUsername, sanitizeUsername as coreSanitizeUsername } from '@mindbase/core';
import { identityHeaderName, isGuarded } from './proxy-identity';

export { DEFAULT_IDENTITY_HEADER } from './proxy-identity';

/** The attribution header (client-sent or proxy-set) is not a valid contributor username. */
export class InvalidUserError extends Error {
  constructor(message = 'Invalid X-Mindbase-User header') { super(message); }
}

/** Guarded mode, but the proxy did not supply an identity (misconfigured proxy). */
export class MissingIdentityError extends Error {
  constructor() { super('Unauthenticated'); }
}

/** Names no proxy identity may carry (compared case-insensitively). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(['unknown']);
/** Last-resort name when an OS username sanitizes to nothing. */
const FALLBACK_OS_USER = 'user';
const MISSING_IDENTITY_LOG_INTERVAL_MS = 60_000;

export interface ResolveUserOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to os.userInfo().username. */
  osUsername?: () => string;
}

type HeaderBag = { headers: Record<string, string | string[] | undefined> };

let missingIdentityCount = 0;
let missingIdentityLoggedAt = 0;

/** Logs every occurrence, but at most one line per interval (with the count since the last line). */
function logMissingIdentity(header: string): void {
  missingIdentityCount += 1;
  const now = Date.now();
  if (now - missingIdentityLoggedAt < MISSING_IDENTITY_LOG_INTERVAL_MS) return;
  console.warn(`[user-attribution] proxy identity header "${header}" missing; answered 401 (${missingIdentityCount} time(s) since last log)`);
  missingIdentityLoggedAt = now;
  missingIdentityCount = 0;
}

/**
 * Deterministically maps an arbitrary name (e.g. an OS account like
 * `oliver@corp` or `John Smith`) onto the contributor-username alphabet.
 */
export function sanitizeUsername(name: string): string {
  return coreSanitizeUsername(name);
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
 *   X-Mindbase-User is ignored. Missing identity → MissingIdentityError (401).
 * - Otherwise: X-Mindbase-User, or the sanitized OS user when absent/empty.
 */
export function resolveUser(req: HeaderBag, options: ResolveUserOptions = {}): string {
  const env = options.env ?? process.env;

  if (isGuarded(env)) {
    const header = identityHeaderName(env);
    const raw = req.headers[header];
    if (raw === undefined || raw === '') {
      logMissingIdentity(header);
      throw new MissingIdentityError();
    }
    if (typeof raw !== 'string' || !isValidUsername(raw) || RESERVED_USERNAMES.has(raw.toLowerCase())) {
      throw new InvalidUserError('Invalid identity header');
    }
    return raw;
  }

  const raw = req.headers['x-mindbase-user'];
  if (typeof raw === 'string' && raw.length > 0) {
    if (!isValidUsername(raw)) throw new InvalidUserError();
    return raw;
  }
  return osFallback(options.osUsername ?? (() => userInfo().username));
}

/** Router middleware: 401 for a missing proxy identity, 400 for an invalid name, before any handler runs. */
export function rejectInvalidUser(req: Request, res: Response, next: NextFunction): void {
  try {
    resolveUser(req);
  } catch (e) {
    if (e instanceof MissingIdentityError) {
      res.status(401).json({ error: e.message });
      return;
    }
    if (!(e instanceof InvalidUserError)) throw e;
    res.status(400).json({ error: e.message });
    return;
  }
  next();
}
