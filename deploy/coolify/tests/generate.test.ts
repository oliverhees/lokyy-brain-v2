// LBV2-27 — static tests for the Coolify package generator (no containers).
// Run: node --test deploy/coolify/tests/generate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGES, buildCompose, outputs, renderBlueprint, renderTraefikDynamic, slotNames, vaultNames,
  type PackageName, type Compose,
} from '../generate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const coolifyDir = join(here, '..');
const pkgs = Object.keys(PACKAGES) as PackageName[];

// Variables a Coolify operator may set; everything secret must be a Coolify magic variable (SERVICE_*).
const OPERATOR_VARS = new Set(['BASE_DOMAIN', 'ADMIN_EMAIL', 'LOKYY_NET_PREFIX', 'LOKYY_TRUSTED_PROXY_CIDRS', 'VAULT_MEM_LIMIT']);
const SECRETISH = /(PASS|SECRET|TOKEN|KEY)/i;

const varsIn = (s: string): string[] => [...s.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
const allStrings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(allStrings) : v && typeof v === 'object' ? Object.values(v).flatMap(allStrings) : [];
const netKeys = (c: Compose, svc: string): string[] => {
  const n = c.services[svc].networks ?? [];
  return (Array.isArray(n) ? n : Object.keys(n)).slice().sort();
};

test('packages: S has 15 slots, M has 30, both plus firma', () => {
  assert.equal(slotNames('s').length, 15);
  assert.equal(slotNames('m').length, 30);
  assert.deepEqual(slotNames('s').slice(0, 2), ['v01', 'v02']);
  assert.equal(slotNames('m').at(-1), 'v30');
  assert.deepEqual(vaultNames('s').at(-1), 'firma');
});

test('generated files are committed and up to date (run: node deploy/coolify/generate.ts)', () => {
  for (const { path, content } of outputs()) {
    let committed = '';
    try { committed = readFileSync(join(coolifyDir, path), 'utf8'); } catch { /* missing */ }
    assert.equal(committed, content, `${path} is stale`);
  }
});

for (const pkg of pkgs) {
  const c = buildCompose(pkg);
  const svcs = Object.keys(c.services);

  test(`${pkg}: one vault service per slot plus firma`, () => {
    for (const v of vaultNames(pkg)) assert.ok(svcs.includes(`vault-${v}`), `vault-${v} missing`);
    assert.equal(svcs.filter((s) => s.startsWith('vault-') && s !== 'vault-connector').length, vaultNames(pkg).length);
  });

  test(`${pkg}: every vault only on its own web/mcp network plus egress`, () => {
    for (const v of vaultNames(pkg)) assert.deepEqual(netKeys(c, `vault-${v}`), ['egress', `mcp-${v}`, `web-${v}`]);
    // each web-<v> / mcp-<v> network has exactly the expected members
    for (const v of vaultNames(pkg)) {
      const on = (n: string) => svcs.filter((s) => netKeys(c, s).includes(n)).sort();
      assert.deepEqual(on(`web-${v}`), ['lokyy-traefik', `vault-${v}`].sort());
      assert.deepEqual(on(`mcp-${v}`), ['vault-connector', `vault-${v}`].sort());
    }
  });

  test(`${pkg}: vault-scoped networks are internal, egress has ICC off`, () => {
    for (const v of vaultNames(pkg)) {
      assert.equal(c.networks[`web-${v}`].internal, true);
      assert.equal(c.networks[`mcp-${v}`].internal, true);
    }
    assert.equal(c.networks.egress.driver_opts?.['com.docker.network.bridge.enable_icc'], 'false');
    for (const n of ['authentik-internal', 'metamcp-internal', 'mcp-upstream', 'portal']) assert.equal(c.networks[n].internal, true, n);
  });

  test(`${pkg}: no host ports, only lokyy-traefik on the coolify network`, () => {
    for (const s of svcs) assert.equal(c.services[s].ports, undefined, `${s} publishes ports`);
    assert.deepEqual(svcs.filter((s) => netKeys(c, s).includes('coolify')), ['lokyy-traefik']);
    assert.equal(c.networks.coolify.external, true);
  });

  test(`${pkg}: MetaMCP not on any vault network; connector on every mcp net + upstream`, () => {
    assert.deepEqual(netKeys(c, 'metamcp'), ['edge', 'mcp-upstream', 'metamcp-internal']);
    assert.deepEqual(netKeys(c, 'vault-connector'), ['mcp-upstream', ...vaultNames(pkg).map((v) => `mcp-${v}`)].sort());
    assert.equal(c.services['vault-connector'].environment?.CONNECTOR_VAULTS, vaultNames(pkg).join(','));
  });

  test(`${pkg}: all secrets from Coolify magic variables, only BASE_DOMAIN/ADMIN_EMAIL required from the operator`, () => {
    const used = new Set(allStrings(c).flatMap(varsIn));
    for (const v of used) {
      assert.ok(v.startsWith('SERVICE_') || OPERATOR_VARS.has(v), `unexpected variable ${v}`);
      if (SECRETISH.test(v)) assert.ok(v.startsWith('SERVICE_'), `secret ${v} is not a magic variable`);
      if (v.startsWith('SERVICE_')) assert.match(v, /^SERVICE_(PASSWORD|PASSWORD_64|HEX_32|HEX_64|BASE64_64|USER)_[A-Z0-9]+$/, v);
    }
    // required operator variables fail loudly when missing
    assert.ok(allStrings(c).some((s) => s.includes('${BASE_DOMAIN:?')));
    assert.ok(allStrings(c).some((s) => s.includes('${ADMIN_EMAIL:?')));
    // one distinct MCP token and proxy secret per vault
    for (const v of vaultNames(pkg)) {
      const env = c.services[`vault-${v}`].environment ?? {};
      assert.match(String(env.MCP_HTTP_TOKEN), /^\$\{SERVICE_HEX_64_MCP[A-Z0-9]+\}$/);
      assert.match(String(env.VAULT_PROXY_SECRET), /^\$\{SERVICE_HEX_64_PROXY[A-Z0-9]+\}$/);
    }
    const tokens = vaultNames(pkg).map((v) => c.services[`vault-${v}`].environment?.MCP_HTTP_TOKEN);
    assert.equal(new Set(tokens).size, tokens.length);
  });

  test(`${pkg}: vault security settings as in deploy/stack`, () => {
    for (const v of vaultNames(pkg)) {
      const s = c.services[`vault-${v}`];
      const env = s.environment ?? {};
      assert.equal(env.MINDBASE_DISABLE_CAPTURE, '1');
      assert.equal(env.VAULT_LLM_ALLOWED_HOSTS, 'api.eurouter.ai');
      assert.equal(env.MINDBASE_MODELS_OFFLINE, '1');
      assert.equal(env.NODE_OPTIONS, '--import=/lokyy/models/offline.mjs');
      assert.equal(env.MCP_HTTP_ALLOWED_HOSTS, `mcp.vault-${v}:4322`);
      assert.ok(s.mem_limit);
      assert.ok((s.volumes ?? []).includes('models:/models:ro'));
      assert.deepEqual(s.depends_on, { 'model-prefetch': { condition: 'service_completed_successfully' } });
      assert.equal(s.labels, undefined, 'inner services carry no Traefik labels');
    }
    assert.ok(c.services['vault-firma'].environment?.MCP_HTTP_READONLY_TOKEN);
  });

  test(`${pkg}: no bind mounts (everything baked into images), gate reads users.json from lokyy-state`, () => {
    for (const s of svcs) {
      for (const vol of c.services[s].volumes ?? []) {
        if (s === 'lokyy-traefik') continue;
        assert.ok(!vol.startsWith('/') && !vol.startsWith('.') && !vol.startsWith('$'), `${s}: bind mount ${vol}`);
      }
    }
    assert.ok(c.services['mcp-gate'].volumes?.includes('lokyy-state:/etc/lokyy:ro'));
    assert.equal(c.services['mcp-gate'].environment?.GATE_USERS_FILE, '/etc/lokyy/users.json');
    assert.ok(c.services.portal.volumes?.includes('lokyy-state:/state'));
    const writers = svcs.filter((s) => (c.services[s].volumes ?? []).some((v) => v.startsWith('lokyy-state:') && !v.endsWith(':ro')));
    assert.deepEqual(writers, ['portal']);
  });

  test(`${pkg}: coolify-proxy labels on lokyy-traefik: one TLS router per public host`, () => {
    const labels = c.services['lokyy-traefik'].labels ?? [];
    const hosts = ['auth', 'mcp', 'app', ...vaultNames(pkg)];
    for (const h of hosts) {
      assert.ok(labels.includes(`traefik.http.routers.lokyy-${h}.rule=Host(\`${h}.\${BASE_DOMAIN}\`)`), `router for ${h}`);
      assert.ok(labels.includes(`traefik.http.routers.lokyy-${h}.tls.certresolver=letsencrypt`));
      assert.ok(labels.includes(`traefik.http.routers.lokyy-${h}.entrypoints=https`));
    }
    assert.ok(labels.includes('traefik.docker.network=coolify'));
    // only lokyy-traefik carries traefik.* labels: the inner routing lives in its file provider
    for (const s of svcs) if (s !== 'lokyy-traefik') assert.ok(!(c.services[s].labels ?? []).some((l) => l.startsWith('traefik.')), s);
  });

  test(`${pkg}: inner Traefik uses only the file provider (no Docker socket)`, () => {
    const t = c.services['lokyy-traefik'];
    assert.ok(!(t.volumes ?? []).some((v) => v.includes('docker.sock')));
    assert.ok(!(t.command ?? []).some((a) => a.startsWith('--providers.docker')));
    // X_authentik_username etc. must not reach WSGI-style backends as an alias of a managed header
    assert.ok(t.command?.includes('--entrypoints.web.http.aliasheadersstrategy=delete'));
  });

  test(`${pkg}: subnets are distinct and inside LOKYY_NET_PREFIX`, () => {
    const subnets = Object.entries(c.networks).filter(([n]) => n !== 'coolify').map(([, n]) => n.ipam?.config[0].subnet);
    assert.equal(new Set(subnets).size, subnets.length);
    for (const s of subnets) assert.match(String(s), /^\$\{LOKYY_NET_PREFIX:-10\.231\}\.\d+\.\d+\/(26|28)$/);
  });

  test(`${pkg}: Traefik dynamic config pins forwarded host and proxy secret per vault`, () => {
    const d = renderTraefikDynamic(pkg);
    for (const v of vaultNames(pkg)) {
      assert.match(d, new RegExp(`vault-${v}:\\n\\s+rule: "Host\\(\`${v}\\.\\{\\{ \\$d \\}\\}\`\\)"`));
      assert.ok(d.includes(`middlewares: ["vault-${v}-fwd", "authentik", "vault-identity", "vault-${v}-secret"]`), v);
      assert.ok(d.includes(`X-Forwarded-Host: "${v}.{{ $d }}"`), v);
      assert.ok(d.includes(`X-Vault-Proxy-Secret: "{{ env \`PROXY_SECRET_${v.toUpperCase()}\` }}"`), v);
      assert.ok(d.includes(`url: "http://vault-${v}:4321"`), v);
    }
    assert.ok(d.includes('        maxResponseBodySize: 1048576\n'), 'forwardAuth response body limit');
    // env referenced by the template is provided to the container
    const env = c.services['lokyy-traefik'].environment ?? {};
    for (const m of d.matchAll(/env `([A-Z0-9_]+)`/g)) assert.ok(m[1] in env, `lokyy-traefik env ${m[1]}`);
  });

  test(`${pkg}: blueprint has one group, provider, app and binding per slot`, () => {
    const b = renderBlueprint(pkg);
    for (const v of slotNames(pkg)) {
      assert.ok(b.includes(`identifiers: { name: vault-${v} }, attrs: { name: vault-${v} } }`), `group vault-${v}`);
      assert.ok(b.includes(`!Format ["https://${v}.%s", !Env BASE_DOMAIN]`), `provider ${v}`);
      assert.ok(b.includes(`group: !KeyOf group-${v}`));
    }
    for (const g of ['vault-firma-read', 'vault-firma-write', 'lokyy-admins']) assert.ok(b.includes(`name: ${g} }`), g);
    assert.ok(b.includes('groups: [!KeyOf group-admins]'), 'bootstrap admin in lokyy-admins');
  });
}

test('S -> M upgrade: every S volume and network exists unchanged in M', () => {
  const s = buildCompose('s'), m = buildCompose('m');
  for (const [k, v] of Object.entries(s.volumes)) assert.deepEqual(m.volumes[k], v, `volume ${k}`);
  for (const [k, v] of Object.entries(s.networks)) assert.deepEqual(m.networks[k], v, `network ${k}`);
  for (const v of vaultNames('s')) {
    assert.deepEqual(m.services[`vault-${v}`].volumes, s.services[`vault-${v}`].volumes);
    assert.deepEqual(m.services[`vault-${v}`].environment, s.services[`vault-${v}`].environment);
  }
});

test('embed flag: off by default, when on every vault gets the embed URL and token', () => {
  assert.equal(buildCompose('s').services.embed, undefined);
  const c = buildCompose('s', { embed: true });
  assert.ok(c.services.embed);
  for (const v of vaultNames('s')) {
    const env = c.services[`vault-${v}`].environment ?? {};
    assert.match(String(env.MINDBASE_EMBED_URL), /^http:\/\/embed:\d+\/embed$/);
    assert.match(String(env.MINDBASE_EMBED_TOKEN), /^\$\{SERVICE_HEX_64_[A-Z0-9]+\}$/);
  }
});
