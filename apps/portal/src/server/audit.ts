// Append-only audit log of admin and key actions (JSON lines, mode 600). Never contains secrets,
// invitation links or API keys — callers pass only identifiers and non-secret details.
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target?: string;
  details?: Record<string, string | number | boolean | null | string[]>;
}

export class AuditLog {
  readonly file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  write(entry: Omit<AuditEntry, 'at'>): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    const run = this.#queue.then(() => appendFile(this.file, line, { mode: 0o600 }));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Newest first. */
  async recent(limit = 200): Promise<AuditEntry[]> {
    if (!existsSync(this.file)) return [];
    const lines = (await readFile(this.file, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().flatMap((l) => {
      try { return [JSON.parse(l) as AuditEntry]; } catch { return []; }
    });
  }
}
