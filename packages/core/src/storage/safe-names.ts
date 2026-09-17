// Validators for untrusted names that become path segments (HTTP params,
// headers, MCP arguments, trash manifests). Shared by core, server and MCP so
// every entry point enforces the same rules.
import nodePath from 'node:path';

/** Matches ids from FileStore.moveToTrash: `<iso-ts with :. → ->-<base36 random>`. */
const TRASH_ENTRY_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{0,5}$/;

export const USERNAME_MAX_LENGTH = 64;
/** ASCII letters/digits, `_`, `-`, `.`; must not start with `.` or `-` (LBV2-14: ASCII only). */
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Names that can never be a contributor (compared case-insensitively). */
const RESERVED_USERNAME_SET: ReadonlySet<string> = new Set(['unknown']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SLUG_MAX_LENGTH = 200;
/** The shape `slugify` produces: lowercase alphanumerics joined by single dashes. */
const PLAIN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SEGMENT_MAX_LENGTH = 255;

export function isValidTrashEntryId(id: string): boolean {
  return TRASH_ENTRY_ID_RE.test(id);
}

/** Contributor usernames name a directory under sources/contributors/. */
export function isValidUsername(name: string): boolean {
  return name.length <= USERNAME_MAX_LENGTH
    && USERNAME_RE.test(name)
    && !name.includes('..')
    && !RESERVED_USERNAME_SET.has(name.toLowerCase());
}

export const USERNAME_RULES_ERROR =
  'Invalid user: use ASCII letters, digits, "_", "-" or "." (not leading "." or "-", no ".."), max 64 characters; "unknown" is reserved.';

/** Last-resort contributor name when an OS account sanitizes to nothing usable. */
export const FALLBACK_USERNAME = 'user';

/**
 * Deterministically maps an arbitrary name (e.g. an OS account like `oliver@corp`,
 * `John Smith` or `jürgen`) onto the contributor-username alphabet.
 */
export function sanitizeUsername(name: string): string {
  let s = name.normalize('NFC').replace(/[^A-Za-z0-9_.-]/g, '_');
  s = s.replace(/\.{2,}/g, '.').replace(/^[.-]+/, '').slice(0, USERNAME_MAX_LENGTH);
  // A name made only of replacement characters (e.g. a non-Latin account) identifies nobody.
  return /[A-Za-z0-9]/.test(s) && isValidUsername(s) ? s : FALLBACK_USERNAME;
}

/**
 * Contributor for a write. An explicit name is validated strictly (never sanitized).
 * Without one, the OS account is sanitized, but only where that is meaningful
 * (local transports); remote callers must name the contributor.
 */
export function resolveContributorUsername(opts: {
  explicit?: string;
  allowOsFallback: boolean;
  osUsername: () => string;
}): { ok: true; user: string } | { ok: false; error: string } {
  if (opts.explicit !== undefined) {
    return isValidUsername(opts.explicit) ? { ok: true, user: opts.explicit } : { ok: false, error: USERNAME_RULES_ERROR };
  }
  if (!opts.allowOsFallback) return { ok: false, error: 'Invalid user: "user" is required on this transport.' };
  try {
    return { ok: true, user: sanitizeUsername(opts.osUsername()) };
  } catch {
    return { ok: true, user: FALLBACK_USERNAME };
  }
}

/** `YYYY-MM-DD` shape (used for dated directories such as sources/raw/<date>). */
export function isValidIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/** A single file or directory name: no separators, no NUL, not `.` or `..`. */
export function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > SEGMENT_MAX_LENGTH) return false;
  if (segment === '.' || segment === '..') return false;
  return !/[/\\\0]/.test(segment);
}

export function isPlainSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && PLAIN_SLUG_RE.test(slug);
}

/**
 * Resolves `segments` against `root` and returns the absolute path only if it
 * lies strictly inside `root` (the root itself is refused); otherwise null.
 */
export function resolveInside(root: string, ...segments: string[]): string | null {
  const base = nodePath.resolve(root);
  const full = nodePath.resolve(base, ...segments);
  return full.startsWith(base + nodePath.sep) ? full : null;
}
