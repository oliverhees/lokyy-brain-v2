// apps/server/src/lib/daily-entry.ts
//
// Append a quick-capture entry to the user's daily contributor file — the
// ONE way free text enters the append-only source layer. Shared by the
// quick-capture route and the contribute op so a thought always exists as
// a citable source before the wiki maintainer touches it.
//
// Deliberately uses node:fs directly against the absolute project root (no
// core `projectPaths` dependency) so it stays trivially portable.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidUsername } from '@mindbase/core';

export async function appendDailyEntry(projectRoot: string, user: string, text: string): Promise<{ file: string }> {
  // `user` names a directory; callers (HTTP header, ops ctx) must not escape it.
  if (!isValidUsername(user)) throw new Error('Invalid username');
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);
  const file = `sources/contributors/${user}/${today}.md`;
  const absFile = join(projectRoot, file);
  await mkdir(dirname(absFile), { recursive: true });
  const body = text.trim();
  const current = await readFile(absFile, 'utf-8').catch(() => null);
  // Re-submitting the last entry (retry after an LLM error, double click)
  // must not duplicate it — the source layer is append-only, not undoable.
  if (current !== null && current.trimEnd().endsWith(body)) return { file };
  const header = current === null ? `# ${today} — ${user}\n` : '';
  await appendFile(absFile, `${header}\n## ${hhmm}\n\n${body}\n`, 'utf-8');

  const logFile = join(projectRoot, 'logs', `${today}.md`);
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `## [${today} ${hhmm}] contribute | user=${user} bytes=${text.length}\n`, 'utf-8');
  return { file };
}
