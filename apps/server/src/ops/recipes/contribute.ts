// apps/server/src/ops/recipes/contribute.ts
import { z } from 'zod';
import { actionsSchema } from '../types';
import type { ProjectCore } from '../gather';

export interface RelatedPage { path: string; excerpt: string }

export const contributePlanSchema = z.object({
  takeaways: z.array(z.string().min(1)).min(1).max(5),
  plan: actionsSchema,
});
export type ContributePlan = z.infer<typeof contributePlanSchema>;

const SYSTEM = `You are Lokyy Brain's wiki maintainer. The project has three layers:
- sources/ is the user's append-only input layer. You NEVER write there.
- context.md is the synthesized "current thinking" document you maintain.
- sources/research/ holds concept pages you create and update.

You respond with ONLY a JSON object, no prose, matching:
{
  "takeaways": ["..."],            // 1-3 key takeaways of the new entry
  "plan": [Action, ...]            // the minimal set of wiki updates
}
Action is EXACTLY one of:
  {"kind":"create_research_page","slug":"kebab-case","markdown":"# Title\\n..."}
  {"kind":"update_context","markdown":"<the FULL rewritten context.md>"}
  {"kind":"append_context_section","section":"Learnings","markdown":"- ..."}
  {"kind":"add_wikilinks","path":"sources/research/<slug>.md","links":["other-slug"]}
Rules: prefer appending to context sections over full rewrites; create at
most ONE new research page and only when the entry introduces a genuinely
new concept; link related pages with add_wikilinks; never invent other
action kinds; keep markdown concise.
CITATIONS: cite the underlying source files with [@<project-relative-path>], e.g. [@sources/contributors/haobing/2026-08-19.md]. Use only paths that appear in this prompt. Every research page must cite at least one source, and every bullet you append to context.md ends with the citation of the entry it came from.
STATE RULE: document the shape of a thing, never a live value that moves on its own (commit SHAs, line counts, "last synced" dates, counters). Write a pointer to where the live value lives instead. Values that do not move — paths, hostnames, names, dated historical facts — are written in full.`;

const MAX_EXISTING_SLUGS = 60;

const listOrNone = (items: string[]): string => (items.length ? items.join(', ') : '(none)');

export function contributePrompt(input: {
  text: string;
  core: ProjectCore;
  related: RelatedPage[];
  /** Project-relative path of the source file the entry lives in. */
  sourcePath: string;
  /** Slugs of research pages already on disk. */
  existingSlugs: string[];
  /** Slugs other pending plans are about to create. */
  pendingSlugs: string[];
}): { system: string; user: string } {
  const related = input.related.length
    ? input.related.map((r) => `--- ${r.path}\n${r.excerpt}`).join('\n')
    : '(none found)';
  return {
    system: SYSTEM,
    user: [
      `NEW ENTRY from the user:\n${input.text}`,
      `SOURCE PATH (cite this in any research page you create or update, verbatim as [@${input.sourcePath}]): ${input.sourcePath}`,
      `CURRENT context.md:\n${input.core.context || '(empty)'}`,
      `PROJECT RULES (README.md):\n${input.core.readme || '(none)'}`,
      `RELATED EXISTING PAGES:\n${related}`,
      `EXISTING RESEARCH PAGES (slugs — never create a duplicate; update/append or add_wikilinks instead):\n${listOrNone(input.existingSlugs.slice(0, MAX_EXISTING_SLUGS))}`,
      `PENDING PAGES (being created by other plans right now — do not create these):\n${listOrNone(input.pendingSlugs)}`,
      'Produce takeaways + the minimal update plan as JSON.',
    ].join('\n\n'),
  };
}
