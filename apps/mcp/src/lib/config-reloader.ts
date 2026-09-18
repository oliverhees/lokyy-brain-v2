import fs from 'node:fs';

/**
 * Keeps a JSON config file current without a restart (LBV2-32): the web UI and
 * the setup portal rewrite mindbase.config.json while the MCP server runs.
 *
 * `current()` stats the file at most once per `minIntervalMs` and re-reads it
 * only when mtime/size changed. A missing file means "not configured" (null);
 * an unreadable or invalid file keeps the last good value and is logged once
 * per version (path only, never the content — it holds the API key). An
 * invalid version is retried on the next check, so a half-written file is
 * picked up as soon as the write completes.
 */
export function createConfigReloader<T>(
  file: string,
  opts: { minIntervalMs: number; log: (line: string) => void },
): { current(): T | null } {
  let value: T | null = null;
  let loadedKey: string | null = null;
  let warnedKey: string | null = null;
  let lastCheck = -Infinity;

  function check(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      value = null;
      loadedKey = null;
      return;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    if (key === loadedKey) return;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
      loadedKey = key;
      warnedKey = null;
    } catch {
      if (warnedKey !== key) {
        warnedKey = key;
        opts.log(`[mindbase-mcp] ${file} is invalid; keeping the last good config\n`);
      }
    }
  }

  return {
    current(): T | null {
      const now = Date.now();
      if (now - lastCheck >= opts.minIntervalMs) {
        lastCheck = now;
        check();
      }
      return value;
    },
  };
}

/** Reload interval from MINDBASE_MCP_CONFIG_RELOAD_MS (default 1000 ms). */
export function configReloadIntervalMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env['MINDBASE_MCP_CONFIG_RELOAD_MS']);
  return env['MINDBASE_MCP_CONFIG_RELOAD_MS'] !== undefined && Number.isFinite(n) && n >= 0 ? n : 1000;
}
