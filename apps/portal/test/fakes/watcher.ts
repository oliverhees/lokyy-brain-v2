// Stand-in for the LBV2-27 provisioning watcher: reads users.json from the state dir and writes
// metamcp-clients.json (contract in docs/setup-portal.md) with fake keys. Call run() to "provision".
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ClientsFile } from '../../src/server/provisioning.ts';
import type { UsersJson } from '../../src/server/slots.ts';

export class FakeWatcher {
  readonly stateDir: string;
  readonly provisionDir: string;
  fail = false;
  runs = 0;
  #prev = new Map<string, { apiKey: string; keyRotation?: string; role: string }>();

  constructor(stateDir: string, provisionDir: string) {
    this.stateDir = stateDir;
    this.provisionDir = provisionDir;
    mkdirSync(provisionDir, { recursive: true });
  }

  run(): ClientsFile {
    this.runs += 1;
    const file = join(this.stateDir, 'users.json');
    const spec: UsersJson = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { companyVault: 'firma', generation: 0, users: [] };
    let out: ClientsFile;
    if (this.fail) {
      out = { generatedAt: new Date().toISOString(), status: 'failed', error: 'boom', restartMetamcp: false, sourceGeneration: spec.generation,
        users: [...this.#prev].map(([username, p]) => ({ username, url: `https://mcp.example.com/metamcp/${username}/mcp`, apiKey: p.apiKey, stale: true, ...(p.keyRotation ? { keyRotation: p.keyRotation } : {}) })) };
    } else {
      let restart = false;
      const next = new Map<string, { apiKey: string; keyRotation?: string; role: string }>();
      for (const u of spec.users) {
        const p = this.#prev.get(u.username);
        const keep = p && p.keyRotation === u.keyRotation && p.role === u.role;
        if (p && !keep) restart = true;
        next.set(u.username, { apiKey: keep ? p.apiKey : `sk_mt_${randomBytes(8).toString('hex')}`, role: u.role, ...(u.keyRotation ? { keyRotation: u.keyRotation } : {}) });
      }
      for (const name of this.#prev.keys()) if (!next.has(name)) restart = true;
      this.#prev = next;
      out = { generatedAt: new Date().toISOString(), status: 'ok', restartMetamcp: restart, sourceGeneration: spec.generation,
        users: spec.users.map((u) => ({ username: u.username, role: u.role, vault: u.vault, url: `https://mcp.example.com/metamcp/${u.username}/mcp`,
          apiKey: next.get(u.username)!.apiKey, ...(u.keyRotation ? { keyRotation: u.keyRotation } : {}) })) };
    }
    writeFileSync(join(this.provisionDir, 'metamcp-clients.json'), JSON.stringify(out));
    return out;
  }
}
