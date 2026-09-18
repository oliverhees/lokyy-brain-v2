// E2E stand-in for the LBV2-27 provisioning watcher, implementing the file contract of
// docs/setup-portal.md: polls $LOKYY_STATE_DIR/users.json, provisions MetaMCP when its generation
// changes, rotates keys whose keyRotation changed, writes $LOKYY_PROVISION_DIR/metamcp-clients.json.
// The real watcher also restarts MetaMCP when restartMetamcp is set; this stand-in only reports it.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { MetamcpProvisioner } from './metamcp.ts';
import type { UsersJson } from '../../../src/server/slots.ts';
import type { ClientsFile } from '../../../src/server/provisioning.ts';

const stateDir = process.env['LOKYY_STATE_DIR'] ?? '/state';
const outDir = process.env['LOKYY_PROVISION_DIR'] ?? '/provision';
const outFile = join(outDir, 'metamcp-clients.json');
const log = (m: string) => console.log(`${new Date().toISOString()} [watcher] ${m}`);
const db = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
const prov = new MetamcpProvisioner({
  db, baseUrl: process.env['METAMCP_URL'] ?? 'http://metamcp:12008', publicBase: process.env['METAMCP_PUBLIC_BASE']!,
  origin: process.env['METAMCP_PUBLIC_BASE']!, env: process.env, log,
});

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}

let last = -1;
async function tick(): Promise<void> {
  const spec = await readJson<UsersJson>(join(stateDir, 'users.json'));
  if (!spec || spec.generation === last) return;
  const previous = await readJson<ClientsFile>(outFile);
  const before = new Map((previous?.users ?? []).map((u) => [u.username, u.keyRotation ?? null]));
  const rotate = spec.users.filter((u) => before.has(u.username) && before.get(u.username) !== (u.keyRotation ?? null)).map((u) => u.username);
  log(`generation ${spec.generation}: ${spec.users.length} users, rotate [${rotate.join(',')}]`);
  const r = await prov.reconcile(spec, { rotate });
  const users = [];
  for (const u of r.users) {
    const key = await prov.readKey(u.username);
    if (key) users.push({ username: u.username, role: u.role, vault: u.vault, url: u.url, apiKey: key,
      ...(spec.users.find((x) => x.username === u.username)?.keyRotation ? { keyRotation: spec.users.find((x) => x.username === u.username)!.keyRotation } : {}) });
  }
  const out: ClientsFile = { generatedAt: new Date().toISOString(), status: r.status, ...(r.error ? { error: r.error } : {}),
    restartMetamcp: r.restartMetamcp, sourceGeneration: spec.generation, users };
  await writeFile(`${outFile}.tmp`, JSON.stringify(out, null, 2), { mode: 0o640 });
  await rename(`${outFile}.tmp`, outFile);
  last = spec.generation;
  log(`wrote ${outFile} (${r.status})`);
}

const loop = async () => {
  try { await tick(); } catch (e) { log(`error: ${(e as Error).message}`); }
  setTimeout(loop, 1500);
};
void loop();
