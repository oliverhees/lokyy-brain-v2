// LBV2-27 — MetaMCP supervisor + provisioning watcher (Coolify packages). PID 1 child of tini in the
// metamcp container; plain JavaScript because the MetaMCP image ships Node 20 (no type stripping), like
// deploy/stack/metamcp/provision.mjs, which it runs.
//
//   node /lokyy/supervisor.mjs ./docker-entrypoint.sh     (the image's original command)
//
// - Starts MetaMCP (own process group) and exits with it if it dies on its own (Docker restarts the container).
// - Watches LOKYY_USERS_FILE (users.json, written by the portal to lokyy-state; read-only here). Every new
//   content (sha256) is provisioned once with provision.mjs: revocations first, each user independently.
//   Invalid or unreadable content is never processed and never replaced by an older state.
// - Rotates a user's key when users[].keyRotation differs from the value recorded for that user in the
//   previous metamcp-clients.json (contract: docs/setup-portal.md, LBV2-28).
// - Writes LOKYY_PROVISION_DIR/metamcp-clients.json (tmp + rename, 0640; the directory is setgid 1000, the
//   portal's group). API keys never appear in logs.
// - Restarts MetaMCP when provisioning reports restartMetamcp (ends open sessions of changed or removed users),
//   at most RESTART_MAX times per RESTART_WINDOW_MS (loop guard); a skipped restart is reported in the file.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESTART_MAX = 3;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
export const RETRY_MS = 60 * 1000;
export const RETRY_MAX = 5;

/** Parses users.json; returns null for anything the watcher must not act on. */
export function parseUsers(text) {
  try {
    const spec = JSON.parse(text);
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.users) || typeof spec.companyVault !== 'string') return null;
    return spec;
  } catch { return null; }
}

export const contentHash = (text) => createHash('sha256').update(text).digest('hex');

/** Users whose key must be rotated: present in the previous file with a different recorded keyRotation. */
export function rotationList(spec, previous) {
  const before = new Map((previous?.users ?? []).filter((u) => u.status !== 'failed' && u.apiKey).map((u) => [u.username, u.keyRotation ?? null]));
  return spec.users
    .filter((u) => typeof u.username === 'string' && before.has(u.username) && before.get(u.username) !== (u.keyRotation ?? null))
    .map((u) => u.username);
}

/** metamcp-clients.json from provision.mjs output (or a failure before it produced any). */
export function clientsFile(spec, result, previous, { restartSkipped = false, now = new Date() } = {}) {
  const want = new Map(spec.users.filter((u) => typeof u.username === 'string').map((u) => [u.username, u]));
  const prevRot = new Map((previous?.users ?? []).map((u) => [u.username, u.keyRotation]));
  const seen = new Set();
  const users = [];
  for (const u of result?.users ?? []) {
    if (!want.has(u.username) || seen.has(u.username)) continue; // never report anyone the portal did not ask for
    seen.add(u.username);
    const ok = u.status === 'ok' && typeof u.apiKey === 'string';
    // A failed user keeps the previously applied keyRotation, so the rotation stays outstanding
    const keyRotation = ok ? want.get(u.username).keyRotation : prevRot.get(u.username);
    users.push({
      username: u.username, role: u.role, vault: u.vault, status: ok ? 'ok' : 'failed',
      ...(ok ? { url: u.url, apiKey: u.apiKey } : { error: String(u.error ?? 'provisioning failed').slice(0, 300) }),
      ...(keyRotation !== undefined ? { keyRotation } : {}),
    });
  }
  for (const [username, u] of want) {
    if (!seen.has(username)) users.push({ username, role: u.role, vault: u.vault, status: 'failed', error: result?.error ? String(result.error).slice(0, 300) : 'not processed', ...(prevRot.get(username) !== undefined ? { keyRotation: prevRot.get(username) } : {}) });
  }
  const status = result?.status === 'ok' && users.every((u) => u.status === 'ok') ? 'ok' : 'failed';
  return {
    generatedAt: now.toISOString(), status, ...(result?.error ? { error: String(result.error).slice(0, 300) } : {}),
    restartMetamcp: Boolean(result?.restartMetamcp), ...(restartSkipped ? { restartSkipped: true } : {}),
    sourceGeneration: spec.generation ?? null, removed: result?.removed ?? [], users,
  };
}

/** Loop guard: at most `max` restarts within `windowMs`. */
export class RestartGuard {
  constructor(max = RESTART_MAX, windowMs = RESTART_WINDOW_MS) { this.max = max; this.windowMs = windowMs; this.times = []; }
  allow(now = Date.now()) {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

/** Decides whether the current file content is (re)processed. */
export class Tracker {
  constructor() { this.hash = null; this.failures = 0; this.lastAttempt = 0; }
  due(hash, now = Date.now()) {
    if (hash !== this.hash) return true;
    return this.failures > 0 && this.failures < RETRY_MAX && now - this.lastAttempt >= RETRY_MS;
  }
  record(hash, ok, now = Date.now()) {
    this.failures = hash === this.hash && !ok ? this.failures + 1 : ok ? 0 : 1;
    this.hash = hash;
    this.lastAttempt = now;
  }
}

// --------------------------------------------------------------------- runtime (not unit-tested)
const log = (m) => console.log(`${new Date().toISOString()} [lokyy-supervisor] ${m}`);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

function runProvision(spec, rotate) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-'], {
      cwd: '/app/apps/backend',
      env: { ...process.env, LOKYY_USERS: JSON.stringify(spec), LOKYY_ROTATE: JSON.stringify(rotate) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => process.stdout.write(d)); // provision.mjs logs never contain keys
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* no output */ }
      resolve(result ?? { status: 'failed', error: `provisioning exited with ${code} without a result`, users: [] });
    });
    child.stdin.end(readFileSync('/lokyy/provision.mjs'));
  });
}

async function main() {
  const cmd = process.argv.slice(2);
  if (!cmd.length) { console.error('usage: supervisor.mjs <metamcp command>...'); process.exit(2); }
  const usersFile = process.env.LOKYY_USERS_FILE ?? '/etc/lokyy/users.json';
  const outFile = join(process.env.LOKYY_PROVISION_DIR ?? '/var/lib/lokyy-provision', 'metamcp-clients.json');
  const guard = new RestartGuard();
  const tracker = new Tracker();
  let child = null;
  let restarting = false;

  const start = () => {
    child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', detached: true });
    child.on('exit', (code, signal) => {
      if (restarting) return;
      log(`MetaMCP exited (${code ?? signal}); stopping the container`);
      process.exit(code ?? 1);
    });
  };
  const stopChild = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const pid = child.pid;
    child.once('exit', () => resolve());
    try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000).unref();
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { restarting = true; await stopChild(); process.exit(0); });

  const healthy = async () => {
    try { return (await fetch('http://127.0.0.1:12008/health', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
  };

  start();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let text;
    try { text = readFileSync(usersFile, 'utf8'); } catch { continue; } // no users yet
    const hash = contentHash(text);
    if (!tracker.due(hash)) continue;
    const spec = parseUsers(text);
    if (!spec) { log('users.json is not valid provisioning input; ignored (nothing changed)'); tracker.record(hash, true); continue; }
    if (!(await healthy())) continue;
    const previous = readJson(outFile);
    const rotate = rotationList(spec, previous);
    log(`generation ${spec.generation ?? '?'}: ${spec.users.length} users, rotate [${rotate.join(',')}]`);
    const result = await runProvision(spec, rotate);
    let restartSkipped = false;
    if (result.restartMetamcp) {
      if (guard.allow()) {
        log('access changed or removed: restarting MetaMCP to end all open sessions');
        restarting = true;
        await stopChild();
        restarting = false;
        start();
      } else {
        restartSkipped = true;
        log(`restart skipped: more than ${RESTART_MAX} restarts within ${RESTART_WINDOW_MS / 60000} min`);
      }
    }
    const file = clientsFile(spec, result, previous, { restartSkipped });
    writeFileSync(`${outFile}.tmp`, JSON.stringify(file, null, 2), { mode: 0o640 });
    renameSync(`${outFile}.tmp`, outFile);
    tracker.record(hash, file.status === 'ok');
    log(`wrote metamcp-clients.json: ${file.status}, ${file.users.filter((u) => u.status === 'ok').length} ok, ${file.users.filter((u) => u.status !== 'ok').length} failed, removed ${file.removed.length}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
