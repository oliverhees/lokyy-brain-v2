// Portal state in the lokyy-state volume (only the portal mounts it read-write):
//   state.json    slot assignments, company and setup data (no secrets)
//   secrets.json  secrets the portal must keep to work (SMTP password); never sent to a client
//   users.json    derived, provision.mjs format + generation/keyRotation; read by the provisioning watcher
// Every write is atomic (temp file + rename; mode 600, users.json 644). Updates are serialised in-process: the portal
// is the only writer, one container, one process.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Role } from '../shared/validation.ts';
import { toUsersJson } from './slots.ts';

export type SlotStatus = 'invited' | 'active' | 'disabled';
export interface SlotUser {
  slot: string;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  status: SlotStatus;
  /** Authentik user pk, null until the Authentik user exists */
  authentikPk: number | null;
  /** Opaque value; a new value asks the provisioning watcher to rotate this user's MCP key */
  keyRotation?: string;
  invitedAt: string;
  /** First portal visit (the user has set a password); null while invited */
  activatedAt?: string | null;
  updatedAt: string;
}

/** A slot whose former user was removed while the vault data was kept: never re-assigned automatically. */
export interface RetiredSlot {
  slot: string;
  formerUsername: string;
  retiredAt: string;
}

export interface VaultLlm {
  /** masked key ("••••abcd"); the key itself lives only in the vault */
  keyHint: string;
  /** EUrouter routing rule ("route") */
  ruleId: string;
  ruleName: string;
}

export interface LlmSettings {
  mode: 'shared' | 'per-vault';
  /** optional; EUrouter picks the model through the route */
  model?: string;
  /** vault ("firma", "v01", …) → what was applied to it */
  vaults: Record<string, VaultLlm>;
  updatedAt: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  updatedAt: string;
}

export interface PortalState {
  version: 1;
  company: { name: string } | null;
  setupCompletedAt: string | null;
  llm: LlmSettings | null;
  smtp: SmtpSettings | null;
  users: SlotUser[];
  retired: RetiredSlot[];
  /** users.json generation; raised whenever the provisioning input changes (watcher contract) */
  usersGeneration: number;
}

export interface PortalSecrets {
  smtpPassword?: string;
  /** HMAC key for CSRF tokens; generated on first start */
  csrfSecret?: string;
}

export function emptyState(): PortalState {
  return { version: 1, company: null, setupCompletedAt: null, llm: null, smtp: null, users: [], retired: [], usersGeneration: 0 };
}

async function writeAtomic(file: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode, flag: 'wx' });
    await chmod(tmp, mode); // independent of the umask
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function readJson<T>(file: string, fallback: () => T): Promise<T> {
  if (!existsSync(file)) return fallback();
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Never overwrite a file we cannot parse: an operator has to look at it.
    throw new Error(`${file}: not valid JSON, refusing to continue`);
  }
}

export class StateStore {
  readonly dir: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  get stateFile(): string { return join(this.dir, 'state.json'); }
  get secretsFile(): string { return join(this.dir, 'secrets.json'); }
  get usersFile(): string { return join(this.dir, 'users.json'); }

  async read(): Promise<PortalState> {
    return { ...emptyState(), ...(await readJson<Partial<PortalState>>(this.stateFile, emptyState)) };
  }

  async readSecrets(): Promise<PortalSecrets> {
    return readJson<PortalSecrets>(this.secretsFile, () => ({}));
  }

  /** Runs fn on a copy of the current state and persists it when fn succeeds. Serialised. */
  update<T>(fn: (state: PortalState) => T | Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const state = await this.read();
      const before = JSON.stringify({ ...toUsersJson(state), generation: 0 });
      const generation = state.usersGeneration;
      const result = await fn(state);
      // Raise the generation when the watcher's input changed (unless fn already did, e.g. a retry nudge).
      if (state.usersGeneration === generation && JSON.stringify({ ...toUsersJson(state), generation: 0 }) !== before) state.usersGeneration += 1;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      // 644: no secrets, and the provisioning watcher runs under another uid
      await writeAtomic(this.usersFile, `${JSON.stringify(toUsersJson(state), null, 2)}\n`, 0o644);
      return result;
    });
  }

  updateSecrets<T>(fn: (secrets: PortalSecrets) => T | Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const secrets = await this.readSecrets();
      const result = await fn(secrets);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeAtomic(this.secretsFile, `${JSON.stringify(secrets)}\n`);
      return result;
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
