// apps/mcp/src/access.ts
// Access profiles for self-hosted deployments (LBV2-10). The read-only profile is
// an ALLOWLIST: a tool is callable only if it is listed here. New upstream tools
// are therefore denied for read-only sessions until they are reviewed and added.
//
// Review rule for this list: no persistent writes to the data dir, no outbound
// network / URL fetching, no LLM or embedding API calls.

export type AccessProfile = 'full' | 'readonly';

// Reviewed 2026-09-16 (LBV2-10). Deliberately excluded although side-effect free:
// list_chats, recall_chat (other users' chat history). Excluded because they call the
// LLM/embedding API or write shared caches: ask_wiki, semantic_search, synthesize_topic,
// find_contradictions, find_gaps, get_pulse, generate_daily_brief.
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
  'mindbase_status',
  'mindbase_gather_sources',
  'mindbase_validate_structure',
]);

// Module-private lookup set: nothing outside this module can add names at runtime.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>(READ_ONLY_TOOL_NAMES);

export function isToolAllowed(profile: AccessProfile, toolName: string): boolean {
  return profile === 'full' || READ_ONLY_TOOLS.has(toolName);
}
