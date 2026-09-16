// apps/mcp/src/lib/slug.ts
// Page slugs become store paths (`wiki/notes/<slug>.md`). A slug may contain `/`
// (e.g. `entities/foo`) but never a parent segment, a backslash, a NUL byte or a
// leading slash, for every access profile.
export function isSafeSlug(slug: string): boolean {
  return !slug.includes('..') && !slug.includes('\\') && !slug.includes('\0') && !slug.startsWith('/');
}
