// apps/server/src/ops/recipes/build.ts
import { z } from 'zod';
import { actionsSchema, CONTEXT_LINE_CAP } from '../types';
import type { ProjectCore, SourceFile } from '../gather';

export const buildSchema = z.object({ actions: actionsSchema.min(1) });
export type BuildOutput = z.infer<typeof buildSchema>;

const SYSTEM = `You are Lokyy Brain's context builder. Your single job: rewrite
context.md so it reflects everything in the unbuilt sources, folded into
the existing document. Respond with ONLY JSON:
{ "actions": [ {"kind":"update_context","markdown":"<FULL new context.md>"} ] }
Optionally add {"kind":"create_research_page",...} actions BEFORE the
update when a source deserves its own concept page (rare; at most 2).
Constraints: keep the document under ${CONTEXT_LINE_CAP - 20} lines; keep the
existing section structure (Current Focus / Active Topics / Key Decisions /
Learnings / Open Questions / Blockers) unless the project README says
otherwise; date new decisions/learnings (YYYY-MM-DD); preserve still-true
content; flag contradictions between sources explicitly with ⚠️.
CITATIONS: when you create or update a research page, cite the underlying source files with [@<project-relative-path>], e.g. [@sources/contributors/anna/2026-08-19.md]. Use only paths that appear in this prompt. Every research page must cite at least one source.
STATE RULE: document the shape of a thing, never a live value that moves on its own (commit SHAs, line counts, "last synced" dates, counters). Write a pointer to where the live value lives instead. Values that do not move — paths, hostnames, names, dated historical facts — are written in full.`;

export function buildPrompt(input: { core: ProjectCore; sources: SourceFile[]; today: string }): { system: string; user: string } {
  const sources = input.sources.map((s) => `--- ${s.path}\n${s.body}`).join('\n\n');
  return {
    system: SYSTEM,
    user: `TODAY: ${input.today}\n\nPROJECT RULES (README.md):\n${input.core.readme || '(none)'}\n\nCURRENT context.md:\n${input.core.context || '(empty — write the first version)'}\n\nUNBUILT SOURCES (newest first):\n${sources || '(none — polish the existing document only)'}\n\nProduce the JSON.`,
  };
}
