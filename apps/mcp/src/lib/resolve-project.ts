// apps/mcp/src/lib/resolve-project.ts
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Context } from '../context.js';

/**
 * Resolve the target project for a tool call. Precedence: explicit argument →
 * config.json currentProjectId. The zero-state error strings are read by the
 * calling LLM, so they spell out exactly which tool to call next instead of
 * just stating the failure.
 */
/** Project ids are directory names under projects/ — never paths (LBV2-11). */
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

const INVALID_ID_ERROR =
  'Invalid projectId: use the project directory name (letters, digits, "-" or "_"), not a path.';

export async function resolveProjectId(
  ctx: Context,
  requested?: string,
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  if (requested) {
    return isValidProjectId(requested) ? { ok: true, projectId: requested } : { ok: false, error: INVALID_ID_ERROR };
  }

  try {
    const cfg = JSON.parse(
      await readFile(join(ctx.dataDir, 'config.json'), 'utf-8'),
    ) as { currentProjectId?: string };
    if (cfg.currentProjectId) {
      return isValidProjectId(cfg.currentProjectId)
        ? { ok: true, projectId: cfg.currentProjectId }
        : { ok: false, error: INVALID_ID_ERROR };
    }
  } catch { /* no config yet */ }

  let available: string[] = [];
  try {
    available = (await readdir(join(ctx.dataDir, 'projects'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* no projects dir */ }

  if (available.length === 0) {
    return {
      ok: false,
      error:
        "No project exists yet. Create one now: call mindbase_init_project({ name: '<short-kebab-name based on what the user is working on>' }) — it becomes the current project automatically — then retry this call.",
    };
  }
  return {
    ok: false,
    error: `No current project selected. Available projects: ${available.join(', ')}. Either pass projectId to this call, or call mindbase_load_project({ projectId: '<one of them>', persist: true }) to make it current, then retry.`,
  };
}
