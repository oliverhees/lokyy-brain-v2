import { userInfo } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import { isValidUsername } from '@mindbase/core';

/** The X-Mindbase-User header is not a valid contributor username. */
export class InvalidUserError extends Error {
  constructor() { super('Invalid X-Mindbase-User header'); }
}

/**
 * The attributed user: the X-Mindbase-User header, or the OS user when the
 * header is absent/empty. The name becomes a directory under
 * sources/contributors/, so an invalid header throws rather than silently
 * falling back (which would misattribute the write).
 */
export function resolveUser(req: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = req.headers['x-mindbase-user'];
  if (typeof raw === 'string' && raw.length > 0) {
    if (!isValidUsername(raw)) throw new InvalidUserError();
    return raw;
  }
  return userInfo().username;
}

/** Router middleware: answers 400 for an invalid X-Mindbase-User header before any handler runs. */
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
