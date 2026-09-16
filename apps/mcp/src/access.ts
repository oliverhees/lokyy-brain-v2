// apps/mcp/src/access.ts
// Access profiles for self-hosted deployments (LBV2-10). The read-only profile is
// an ALLOWLIST: a tool is callable only if it is listed here. New upstream tools
// are therefore denied for read-only sessions until they are reviewed and added.
//
// Review rule for this list: no persistent writes to the data dir, no outbound
// network / URL fetching. An LLM call is allowed only after review against the reader
// view (only visible pages may reach the provider) and only for tools listed in
// LLM_TOOL_NAMES, which puts every reader call under the LLM rate limit.

export type AccessProfile = 'full' | 'readonly';

// Reviewed 2026-09-16 (LBV2-10). Deliberately excluded although side-effect free:
// list_chats, recall_chat (other users' chat history). Excluded because they call the
// LLM/embedding API or write shared caches: semantic_search, synthesize_topic,
// find_contradictions, find_gaps, get_pulse, generate_daily_brief.
// Removed in LBV2-12 (fail closed): mindbase_status, mindbase_gather_sources and
// mindbase_validate_structure read the data dir with raw node:fs, bypassing the reader
// view, and expose file names, mtimes and absolute project paths.
// Added in LBV2-18 (decision Oliver 2026-09-16): ask_wiki. Its retrieval runs entirely
// through the reader view, it writes nothing, and reader calls are rate limited.
export const READ_ONLY_TOOL_NAMES: readonly string[] = Object.freeze([
  'search_wiki',
  'search_all_projects',
  'search_in_project',
  'read_wiki_page',
  'list_recent',
  'find_related',
  'get_graph_insights',
  'find_orphans',
  'suggest_links',
  'export_subgraph',
  'list_feeds',
  'list_review_cards',
  'ask_wiki',
]);

/** Tools that call the LLM or embedding API; reader calls of these are rate limited (LBV2-18). */
export const LLM_TOOL_NAMES: readonly string[] = Object.freeze([
  'ask_wiki',
  'semantic_search',
  'synthesize_topic',
  'find_contradictions',
  'find_gaps',
  'get_pulse',
  'generate_daily_brief',
]);

// Module-private lookup sets: nothing outside this module can add names at runtime.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>(READ_ONLY_TOOL_NAMES);
const LLM_TOOLS: ReadonlySet<string> = new Set<string>(LLM_TOOL_NAMES);

export function isToolAllowed(profile: AccessProfile, toolName: string): boolean {
  return profile === 'full' || READ_ONLY_TOOLS.has(toolName);
}

/** True when a call of this tool in this profile must pass the reader LLM rate limit. */
export function isRateLimitedTool(profile: AccessProfile, toolName: string): boolean {
  return profile === 'readonly' && LLM_TOOLS.has(toolName);
}
