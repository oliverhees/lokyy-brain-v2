// MetaMCP provisioning is done by a watcher inside the metamcp container (LBV2-27), not by the portal:
//   portal  → $LOKYY_STATE_DIR/users.json          (provision.mjs format + generation + per-user keyRotation)
//   watcher → $LOKYY_PROVISION_DIR/metamcp-clients.json (read-only here: url, apiKey, status per user,
//             plus sourceGeneration and the keyRotation it applied)
// The field contract is documented in docs/setup-portal.md ("Provisioning contract").
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsersJson } from './slots.ts';

export interface ClientEntry {
  username: string;
  role?: string;
  vault?: string;
  url: string;
  apiKey: string;
  keyRotation?: string;
  stale?: boolean;
}

export interface ClientsFile {
  generatedAt: string;
  status: string;
  error?: string;
  restartMetamcp?: boolean;
  sourceGeneration?: number;
  users: ClientEntry[];
}

export type ProvisioningState = 'pending' | 'ok' | 'failed';

export interface UserProvisioning {
  state: ProvisioningState;
  /** Endpoint URL as provisioned (null until known) */
  url: string | null;
  /** Current API key, null while pending/failed or while a rotation is outstanding */
  apiKey: string | null;
}

export interface ProvisioningView {
  overall: { state: ProvisioningState; at: string | null; error: string | null; restartMetamcp: boolean };
  user(username: string): UserProvisioning;
}

export function provisioningView(spec: UsersJson, clients: ClientsFile | null): ProvisioningView {
  if (!clients) {
    return {
      overall: { state: 'pending', at: null, error: null, restartMetamcp: false },
      user: () => ({ state: 'pending', url: null, apiKey: null }),
    };
  }
  const current = clients.sourceGeneration === undefined || clients.sourceGeneration >= spec.generation;
  const failed = clients.status !== 'ok';
  const overall = {
    state: (!current ? 'pending' : failed ? 'failed' : 'ok') as ProvisioningState,
    at: clients.generatedAt ?? null,
    error: failed ? clients.error ?? 'provisioning failed' : null,
    restartMetamcp: clients.restartMetamcp === true,
  };
  const entries = new Map(clients.users.map((e) => [e.username, e]));
  return {
    overall,
    user(username) {
      const wanted = spec.users.find((u) => u.username === username);
      const entry = entries.get(username);
      if (!wanted) return { state: 'pending', url: null, apiKey: null };
      const usable = entry && !entry.stale && (entry.keyRotation ?? null) === (wanted.keyRotation ?? null);
      if (usable) return { state: 'ok', url: entry.url, apiKey: entry.apiKey };
      if (current && failed) return { state: 'failed', url: null, apiKey: null };
      // not processed yet (new user) or rotation outstanding: the URL stays valid, the key does not
      return { state: current && !failed && !entry ? 'failed' : 'pending', url: entry && !entry.stale ? entry.url : null, apiKey: null };
    },
  };
}

const isEntry = (e: unknown): e is ClientEntry =>
  !!e && typeof e === 'object' && typeof (e as ClientEntry).username === 'string'
  && typeof (e as ClientEntry).url === 'string' && typeof (e as ClientEntry).apiKey === 'string';

export class FileProvisioning {
  readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'metamcp-clients.json');
  }

  /** null = the watcher has not written anything yet. Unreadable content counts as a failed run. */
  async read(): Promise<ClientsFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const broken: ClientsFile = { generatedAt: new Date(0).toISOString(), status: 'failed', error: 'metamcp-clients.json unreadable', users: [] };
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return broken; }
    const d = data as Partial<ClientsFile>;
    if (!d || typeof d !== 'object' || !Array.isArray(d.users)) return broken;
    return {
      generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : broken.generatedAt,
      status: typeof d.status === 'string' ? d.status : 'failed',
      ...(typeof d.error === 'string' ? { error: d.error } : {}),
      restartMetamcp: d.restartMetamcp === true,
      ...(Number.isInteger(d.sourceGeneration) ? { sourceGeneration: d.sourceGeneration as number } : {}),
      users: d.users.filter(isEntry),
    };
  }
}
