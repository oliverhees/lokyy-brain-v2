// apps/mcp/src/lib/slug.ts
// Page slugs become store paths (`wiki/notes/<slug>.md`). A slug may contain `/`
// (e.g. `entities/foo`, graph keys like `default/<slug>`) and dots inside a segment
// (e.g. `v1..v2`), but never a `.` or `..` path segment, a backslash, a NUL byte or a
// leading slash, for every access profile.
export function isSafeSlug(slug: string): boolean {
  if (slug.includes('\\') || slug.includes('\0') || slug.startsWith('/')) return false;
  return slug.split('/').every((segment) => segment !== '..' && segment !== '.');
}

/**
 * Tool arguments that denote a page slug, validated centrally by the tool dispatcher for
 * every tool and profile. Matched by argument name so tools added later are covered too.
 */
export const SLUG_ARGUMENT_NAMES: readonly string[] = Object.freeze([
  'slug', 'slugs', 'source_slug', 'target_slug', 'root',
  // LBV2-18 (audit N3 residual): ask_wiki context pages and ingest_plan raw ids are store paths too.
  'context_pages', 'raw_id',
]);

/** Generic rejection text: echoes neither the slug nor any path. */
export const UNSAFE_SLUG_ERROR = 'Invalid input: unsafe slug';

/** True when every slug-typed argument (string or string array) is a safe slug. */
export function slugArgumentsAreSafe(args: Record<string, unknown>): boolean {
  for (const name of SLUG_ARGUMENT_NAMES) {
    const value = args[name];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) if (typeof v === 'string' && !isSafeSlug(v)) return false;
  }
  return true;
}
