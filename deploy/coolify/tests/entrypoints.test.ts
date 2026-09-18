// LBV2-27 — tests for the shell entrypoints baked into the package images (run with fake `ip`/`traefik`).
// Run: node --test deploy/coolify/tests/entrypoints.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const coolify = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakeBin(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lokyy-ep-'));
  for (const [name, body] of Object.entries(files)) { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); }
  return dir;
}
const IP_ADDR = (lines: string[]) => `cat <<'X'\n${lines.join('\n')}\nX`;

function traefik(env: Record<string, string>, addrs: string[]) {
  const bin = fakeBin({ ip: IP_ADDR(addrs), traefik: 'printf "%s\\n" "$@"' });
  const r = spawnSync('sh', [join(coolify, 'traefik/entrypoint.sh'), '--api.dashboard=false'], {
    env: { PATH: `${bin}:/usr/bin:/bin`, BASE_DOMAIN: 'lokyy.example.de', NET_PREFIX: '10.231', ...env }, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lo = '1: lo    inet 127.0.0.1/8 scope host lo';
const own = (n: number, a: string) => `${n}: eth${n}    inet ${a} brd x scope global eth${n}`;

test('traefik: trusts exactly the coolify network subnet (the one interface outside LOKYY_NET_PREFIX)', () => {
  const r = traefik({}, [lo, own(1, '10.231.3.2/28'), own(2, '10.0.1.7/24'), own(3, '10.231.0.3/28')]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n'), ['--api.dashboard=false', '--entrypoints.web.forwardedHeaders.trustedIPs=10.0.1.7/24']);
});
test('traefik: LOKYY_TRUSTED_PROXY_CIDRS overrides detection; bad characters refused', () => {
  const r = traefik({ LOKYY_TRUSTED_PROXY_CIDRS: '10.0.1.2/32' }, [lo, own(2, '10.0.1.7/24')]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('--entrypoints.web.forwardedHeaders.trustedIPs=10.0.1.2/32'));
  assert.notEqual(traefik({ LOKYY_TRUSTED_PROXY_CIDRS: '0/0 --x' }, [lo]).code, 0);
});
test('traefik: refuses to start without exactly one foreign interface (fail closed)', () => {
  assert.notEqual(traefik({}, [lo, own(1, '10.231.3.2/28')]).code, 0);
  assert.notEqual(traefik({}, [lo, own(1, '10.0.1.7/24'), own(2, '172.20.0.2/16')]).code, 0);
});
test('traefik: refuses invalid BASE_DOMAIN', () => {
  for (const d of ['', 'Lokyy.de', 'x', 'a..b', '-a.de', 'a.de`) || Host(`x', 'a.de/', 'a.de\nb`c']) assert.notEqual(traefik({ BASE_DOMAIN: d }, [lo, own(2, '10.0.1.7/24')]).code, 0, d);
});

function initCheck(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'lokyy-init-'));
  mkdirSync(join(root, 'state')); mkdirSync(join(root, 'provision'));
  const bin = fakeBin({ chown: 'echo "chown $*" >> "$LOG"', chmod: 'echo "chmod $*" >> "$LOG"' });
  const r = spawnSync('sh', [join(coolify, 'metamcp-init/init-check.sh')], {
    env: { PATH: `${bin}:/usr/bin:/bin`, LOG: join(root, 'log'), LOKYY_STATE: join(root, 'state'), LOKYY_PROVISION: join(root, 'provision'), ...env }, encoding: 'utf8',
  });
  let log = ''; try { log = String(spawnSync('cat', [join(root, 'log')], { encoding: 'utf8' }).stdout); } catch { /* none */ }
  return { code: r.status, err: r.stderr, log, root };
}
test('init-check: accepts a normal domain and e-mail, then prepares volume ownership', () => {
  const r = initCheck({ BASE_DOMAIN: 'lokyy.example.de', ADMIN_EMAIL: 'ops.team+x@example.de' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.log, /chown 1000:1000 .*state/);
  assert.match(r.log, /chown 1001:1000 .*provision/);
  assert.ok(statSync(r.root).isDirectory());
});
test('init-check: rejects injection-prone input', () => {
  for (const email of ['', "a'b@example.de", 'a"b@x.de', 'a@b', 'a b@x.de', 'a@x.de;id', 'a@x.de\n', 'a@X.DE`']) {
    assert.notEqual(initCheck({ BASE_DOMAIN: 'lokyy.example.de', ADMIN_EMAIL: email }).code, 0, JSON.stringify(email));
  }
  for (const d of ['', 'lokyy', 'LOKYY.de', "a'.de", 'a.de`x', 'a.de\nx']) assert.notEqual(initCheck({ BASE_DOMAIN: d, ADMIN_EMAIL: 'a@x.de' }).code, 0, d);
});
