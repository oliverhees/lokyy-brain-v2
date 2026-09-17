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
