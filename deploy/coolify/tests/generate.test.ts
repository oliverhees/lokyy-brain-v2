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
const OPERATOR_VARS = new Set(['BASE_DOMAIN', 'ADMIN_EMAIL', 'LOKYY_NET_PREFIX', 'LOKYY_TRUSTED_PROXY_CIDRS', 'VAULT_MEM_LIMIT', 'EMBED_MEM_LIMIT', 'COOLIFY_RESOURCE_UUID']);
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
    for (const v of vaultNames(pkg)) assert.deepEqual(netKeys(c, `vault-${v}`), ['egress', `embed-${v}`, `mcp-${v}`, `web-${v}`]);
    // each web-<v> / mcp-<v> network has exactly the expected members
    for (const v of vaultNames(pkg)) {
      const on = (n: string) => svcs.filter((s) => netKeys(c, s).includes(n)).sort();
      assert.deepEqual(on(`web-${v}`), ['lokyy-traefik', `vault-${v}`].sort());
      assert.deepEqual(on(`mcp-${v}`), ['vault-connector', `vault-${v}`].sort());
      assert.deepEqual(on(`embed-${v}`), ['embed', `vault-${v}`].sort());
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
      assert.ok(!(s.volumes ?? []).some((x) => x.startsWith('models:')), 'vaults embed via the shared service');
      assert.deepEqual(s.depends_on, { embed: { condition: 'service_healthy' }, 'lokyy-init': { condition: 'service_completed_successfully' } }, 'BASE_DOMAIN in the build args: validated first');
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
    assert.ok(c.services.portal.volumes?.includes('lokyy-state:/state'));
    const writers = svcs.filter((s) => (c.services[s].volumes ?? []).some((v) => v.startsWith('lokyy-state:') && !v.endsWith(':ro')));
    assert.deepEqual(writers.sort(), ['lokyy-init', 'portal']);
  });

  test(`${pkg}: coolify-proxy labels on lokyy-traefik: one TLS router per public host`, () => {
    const labels = c.services['lokyy-traefik'].labels ?? [];
    const hosts = ['auth', 'mcp', 'app', ...vaultNames(pkg)];
    for (const h of hosts) {
      assert.ok(labels.includes(`traefik.http.routers.lokyy-\${COOLIFY_RESOURCE_UUID:?}-${h}.rule=Host(\`${h}.\${BASE_DOMAIN}\`)`), `router for ${h}`);
      assert.ok(labels.includes(`traefik.http.routers.lokyy-\${COOLIFY_RESOURCE_UUID:?}-${h}.tls.certresolver=letsencrypt`));
      assert.ok(labels.includes(`traefik.http.routers.lokyy-\${COOLIFY_RESOURCE_UUID:?}-${h}.entrypoints=https`));
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
      assert.ok(d.includes(`url: "http://{{ $n }}.${2 + (v === 'firma' ? 0 : Number(v.slice(1)))}.14:4321"`), v);
    }
    assert.ok(d.includes('        maxResponseBodySize: 1048576\n'), 'forwardAuth response body limit');
    // env referenced by the template is provided to the container
    const env = c.services['lokyy-traefik'].environment ?? {};
    for (const m of d.matchAll(/env `([A-Z0-9_]+)`/g)) assert.ok(m[1] in env, `lokyy-traefik env ${m[1]}`);
  });

  test(`${pkg}: only the Authentik worker applies the blueprint (a second applier deadlocks)`, () => {
    assert.equal(c.services['authentik-blueprint'], undefined);
    // the blueprint is baked into the image, so a changed package recreates the worker, whose startup
    // discovery applies the changed file
    assert.deepEqual(c.services['authentik-worker'].build?.args, { LOKYY_PACKAGE: pkg });
  });

  test(`${pkg}: connector address cannot be taken by a dynamically addressed container`, () => {
    const cfg = c.networks['mcp-upstream'].ipam?.config[0];
    assert.equal(cfg?.subnet, '${LOKYY_NET_PREFIX:-10.231}.0.48/28');
    assert.equal(cfg?.ip_range, '${LOKYY_NET_PREFIX:-10.231}.0.48/29');
    const nets = c.services['vault-connector'].networks as Record<string, { ipv4_address?: string }>;
    assert.equal(nets['mcp-upstream'].ipv4_address, '${LOKYY_NET_PREFIX:-10.231}.0.62');
    assert.equal(c.services['vault-connector'].environment?.CONNECTOR_LISTEN_HOST, '${LOKYY_NET_PREFIX:-10.231}.0.62');
  });

  test(`${pkg}: blueprint has one group, provider, app and binding per slot`, () => {
    const b = renderBlueprint(pkg);
    for (const v of slotNames(pkg)) {
      assert.ok(b.includes(`identifiers: { name: vault-${v} }, attrs: { name: vault-${v} } }`), `group vault-${v}`);
      assert.ok(b.includes(`!Format ["https://${v}.%s", !Env BASE_DOMAIN]`), `provider ${v}`);
      assert.ok(b.includes(`group: !KeyOf group-${v}`));
    }
    for (const g of ['vault-firma-read', 'vault-firma-write', 'lokyy-admins']) assert.ok(b.includes(`name: ${g} }`), g);
    // Adds lokyy-admins without dropping "authentik Admins" (the superuser group of akadmin)
    assert.ok(b.includes('groups: [!Find [authentik_core.group, [name, "authentik Admins"]], !KeyOf group-admins]'), 'bootstrap admin keeps superuser');
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

test('embed (LBV2-26 contract, on in the packages): one token and one network per vault, fixed addresses', () => {
  assert.ok(buildCompose('s').services.embed, 'on by default');
  assert.equal(buildCompose('s', { embed: false }).services.embed, undefined);
  const c = buildCompose('s');
  const e = c.services.embed;
  assert.deepEqual(e.build, { context: '../..', dockerfile: 'deploy/Dockerfile', target: 'embed' });
  assert.equal(e.read_only, true);
  assert.deepEqual(e.cap_drop, ['ALL']);
  assert.deepEqual(e.sysctls, { 'net.ipv4.ip_forward': '0' });
  assert.deepEqual(e.volumes, ['models:/models:ro']);
  assert.equal(e.mem_limit, '${EMBED_MEM_LIMIT:-4g}');
  assert.equal(e.environment?.NODE_OPTIONS, '--import=/lokyy/models/offline.mjs');
  assert.deepEqual(netKeys(c, 'embed'), vaultNames('s').map((v) => `embed-${v}`).sort());
  assert.equal(e.environment?.EMBED_VAULTS, vaultNames('s').join(','));
  const svcs = Object.keys(c.services);
  for (const v of vaultNames('s')) {
    const V = v.toUpperCase();
    const s = c.services[`vault-${v}`];
    const env = s.environment ?? {};
    const k = v === 'firma' ? 0 : Number(v.slice(1));
    assert.equal(env.MINDBASE_EMBED_URL, `http://\${LOKYY_NET_PREFIX:-10.231}.${2 + k}.46:8080`, 'fixed address, not a name');
    assert.equal((c.services.embed.networks as Record<string, { ipv4_address?: string }>)[`embed-${v}`].ipv4_address, `\${LOKYY_NET_PREFIX:-10.231}.${2 + k}.46`);
    assert.equal(c.networks[`embed-${v}`].ipam?.config[0].ip_range, `\${LOKYY_NET_PREFIX:-10.231}.${2 + k}.32/29`);
    // embed requires >= 16 distinct characters: a random 64-char hex string misses one of its 16 digits ~25% of the time
    assert.equal(env.MINDBASE_EMBED_TOKEN, `\${SERVICE_PASSWORD_64_EMB${V}}`);
    assert.equal(e.environment?.[`EMBED_TOKEN_${V}`], env.MINDBASE_EMBED_TOKEN, 'plain token = same magic var');
    assert.equal(e.environment?.[`EMBED_SOURCE_${V}`], c.networks[`embed-${v}`].ipam?.config[0].subnet);
    assert.deepEqual(netKeys(c, `vault-${v}`), ['egress', `embed-${v}`, `mcp-${v}`, `web-${v}`]);
    assert.deepEqual(svcs.filter((x) => netKeys(c, x).includes(`embed-${v}`)).sort(), ['embed', `vault-${v}`]);
    assert.equal(c.networks[`embed-${v}`].internal, true);
    assert.ok(!(s.volumes ?? []).some((x) => x.startsWith('models:')), 'vaults no longer mount the model');
    assert.equal(s.mem_limit, '${VAULT_MEM_LIMIT:-1g}');
    assert.deepEqual(s.depends_on, { embed: { condition: 'service_healthy' }, 'lokyy-init': { condition: 'service_completed_successfully' } }, 'BASE_DOMAIN in the build args: validated first');
  }
});

test('portal wiring (LBV2-28 contract)', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const p = c.services.portal;
    const t = c.services['lokyy-traefik'];
    const pnets = p.networks as Record<string, { ipv4_address?: string }>;
    const tnets = t.networks as Record<string, { ipv4_address?: string }>;
    assert.deepEqual(Object.keys(pnets).sort(), ['edge', 'metamcp-internal', 'portal', 'portal-gate']);
    assert.equal(pnets.portal.ipv4_address, '${LOKYY_NET_PREFIX:-10.231}.0.94');
    assert.equal(tnets.portal.ipv4_address, '${LOKYY_NET_PREFIX:-10.231}.0.93');
    assert.deepEqual(c.networks.portal.ipam?.config[0], { subnet: '${LOKYY_NET_PREFIX:-10.231}.0.80/28', ip_range: '${LOKYY_NET_PREFIX:-10.231}.0.80/29' });
    assert.deepEqual(Object.keys(c.services).filter((s) => netKeys(c, s).includes('portal')).sort(), ['lokyy-traefik', 'portal']);
    // admin entrypoint listens only on Traefik's portal-network address
    assert.ok(t.command?.includes('--entrypoints.portal-admin.address=${LOKYY_NET_PREFIX:-10.231}.0.93:8090'));
    assert.equal(t.environment?.PORTAL_IP, '${LOKYY_NET_PREFIX:-10.231}.0.94');
    assert.equal(p.read_only, true);
    assert.deepEqual(p.cap_drop, ['ALL']);
    const env = p.environment ?? {};
    assert.equal(env.LOKYY_DOMAIN, '${BASE_DOMAIN:?set BASE_DOMAIN in Coolify}');
    assert.equal(env.LOKYY_SLOTS, slotNames(pkg).join(','));
    assert.equal(env.VAULT_ADMIN_URL, 'http://${LOKYY_NET_PREFIX:-10.231}.0.93:8090');
    assert.equal(env.AUTHENTIK_API_TOKEN, undefined, 'the portal gets no Authentik token (authentik-gate holds it)');
    assert.equal(env.VAULT_PROXY_SECRET, t.environment?.PROXY_SECRET_PORTAL);
  }
});

test('portal-admin routes: only config API per vault, portal IP only, fixed identity', () => {
  for (const pkg of pkgs) {
    const d = renderTraefikDynamic(pkg);
    for (const v of vaultNames(pkg)) {
      const block = d.slice(d.indexOf(`    vault-${v}-admin:\n`)).split('\n').slice(0, 5).join('\n');
      assert.equal(block, [
        `    vault-${v}-admin:`,
        `      rule: "(Path(\`/${v}/api/config\`) && (Method(\`GET\`) || Method(\`PUT\`))) || (Path(\`/${v}/api/config/test\`) && Method(\`POST\`))"`,
        '      entryPoints: ["portal-admin"]',
        `      middlewares: ["portal-only", "vault-${v}-admin-strip", "vault-${v}-admin-hdr"]`,
        `      service: "vault-${v}"`,
      ].join('\n'));
      const hdr = d.slice(d.indexOf(`    vault-${v}-admin-hdr:\n`)).split('\n').slice(0, 10).join('\n');
      for (const line of [
        `X-Vault-Proxy-Secret: "{{ env \`PROXY_SECRET_${v.toUpperCase()}\` }}"`, 'X-authentik-username: "lokyy-portal"',
        'X-authentik-groups: "lokyy-admins"', 'X-authentik-email: ""', 'X-authentik-uid: ""', 'X-Mindbase-User: ""',
      ]) assert.ok(hdr.includes(line), `${v}: ${line}`);
    }
    assert.ok(d.includes('    portal-only:\n      ipAllowList:\n        sourceRange: ["{{ env `PORTAL_IP` }}/32"]\n'));
    // no router on the public entrypoint reaches the admin identity
    assert.equal((d.match(/entryPoints: \["portal-admin"\]/g) ?? []).length, vaultNames(pkg).length);
  }
});

test('blueprint: every invited user (lokyy-users) and operators reach the portal', () => {
  const b = renderBlueprint('s');
  assert.ok(b.includes('identifiers: { name: lokyy-users }, attrs: { name: lokyy-users } }'));
  assert.ok(b.includes('identifiers: { target: !KeyOf app-portal, group: !KeyOf group-users }'));
  assert.ok(b.includes('identifiers: { target: !KeyOf app-portal, group: !KeyOf group-admins }'));
});

test('authentik image bakes the portal blueprint (invitation / set-password flow)', () => {
  const df = readFileSync(join(coolifyDir, 'authentik/Dockerfile'), 'utf8');
  assert.match(df, /COPY [^\n]*apps\/portal\/authentik\/lokyy-portal\.yam\S* \/blueprints\/custom\//);
});

// ---------------------------------------------------------------- audit round 1 (LBV2-27)
const P = '${LOKYY_NET_PREFIX:-10.231}';
const addr = (c: Compose, svc: string, net: string) => (c.services[svc].networks as Record<string, { ipv4_address?: string }>)[net]?.ipv4_address;

test('HIGH-1: lokyy-traefik (on the shared coolify network) reaches every upstream by fixed IP, never by name', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const d = renderTraefikDynamic(pkg);
    const urls = [...d.matchAll(/(?:url|address): "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(urls.length > vaultNames(pkg).length);
    for (const u of urls) assert.match(u, /^http:\/\/\{\{ \$n \}\}\.\d+\.\d+:\d+(\/|$)/, `upstream by name: ${u}`);
    assert.ok(d.includes('{{ $n := env `NET_PREFIX` }}'));
    assert.equal(c.services['lokyy-traefik'].environment?.NET_PREFIX, P);
    // every IP used in dynamic.yml is a fixed address of the intended service
    const want: Record<string, string> = {
      'authentik-server:edge': `${P}.0.10`, 'metamcp:edge': `${P}.0.11`, 'mcp-gate:edge': `${P}.0.12`, 'portal:portal': `${P}.0.94`,
    };
    for (const v of vaultNames(pkg)) want[`vault-${v}:web-${v}`] = subnet4(v, 14);
    for (const [k, ip] of Object.entries(want)) {
      const [svc, net] = k.split(':');
      assert.equal(addr(c, svc, net), ip, k);
      assert.ok(urls.some((u) => u.startsWith(`http://${ip.replace(P, '{{ $n }}')}:`)), `${k} used in dynamic.yml`);
    }
    // fixed addresses lie outside the dynamic ip_range of their network
    for (const n of ['edge', ...vaultNames(pkg).map((v) => `web-${v}`)]) assert.match(String(c.networks[n].ipam?.config[0].ip_range), /\/29$/, n);
  }
});
function subnet4(v: string, host: number): string {
  const k = v === 'firma' ? 0 : Number(v.slice(1));
  return `${P}.${2 + k}.${host}`;
}

test('MED-1: X-Forwarded-* trusted only from the coolify network (detected at start), auth router pinned', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const t = c.services['lokyy-traefik'];
    assert.ok(!(t.command ?? []).some((a) => a.includes('trustedIPs')), 'set by the entrypoint from the coolify interface');
    assert.equal(t.environment?.LOKYY_TRUSTED_PROXY_CIDRS, '${LOKYY_TRUSTED_PROXY_CIDRS:-}');
    const d = renderTraefikDynamic(pkg);
    assert.ok(d.includes('    authentik:\n      rule: "Host(`auth.{{ $d }}`)"\n      entryPoints: ["web"]\n      middlewares: ["auth-fwd"]\n'));
    assert.ok(d.includes('    auth-fwd:\n      headers:\n        customRequestHeaders:\n          X-Forwarded-Host: "auth.{{ $d }}"'));
  }
});

test('MED-2: coolify-proxy router, middleware and service names are unique per Coolify resource', () => {
  for (const pkg of pkgs) {
    const labels = buildCompose(pkg).services['lokyy-traefik'].labels ?? [];
    for (const l of labels.filter((x) => /^traefik\.http\.(routers|middlewares|services)\./.test(x))) {
      assert.match(l, /^traefik\.http\.(routers|middlewares|services)\.lokyy-\$\{COOLIFY_RESOURCE_UUID:\?\}-[a-z0-9-]+\./, l);
    }
  }
});

test('LOW-B: no default instance id; rendering stops without COOLIFY_RESOURCE_UUID (no silent lokyy-local-* collision)', () => {
  for (const { path, content } of outputs()) assert.ok(!content.includes('COOLIFY_RESOURCE_UUID:-'), path);
  for (const pkg of pkgs) {
    const labels = buildCompose(pkg).services['lokyy-traefik'].labels ?? [];
    assert.ok(labels.filter((l) => l.includes('COOLIFY_RESOURCE_UUID')).length > 0);
    for (const l of labels.filter((x) => x.includes('COOLIFY_RESOURCE_UUID'))) {
      assert.ok(!/\$\{COOLIFY_RESOURCE_UUID(?!:\?\})/.test(l), l);
    }
  }
});

test('LOW-1: BASE_DOMAIN and ADMIN_EMAIL validated before any service uses them; volume ownership prepared', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const init = c.services['lokyy-init'];
    assert.deepEqual(init.entrypoint, ['/lokyy/init-check.sh']);
    assert.equal(init.restart, 'no');
    assert.deepEqual(init.cap_drop, ['ALL']);
    assert.deepEqual(init.cap_add, ['CHOWN', 'FOWNER']);
    assert.equal(init.network_mode, 'none');
    assert.deepEqual(init.volumes, ['lokyy-state:/state']);
    const users = ['BASE_DOMAIN', 'ADMIN_EMAIL'];
    for (const [name, svc] of Object.entries(c.services)) {
      if (name === 'lokyy-init') continue;
      const uses = allStrings(svc).some((x) => users.some((u) => x.includes(`\${${u}`)));
      const mountsState = (svc.volumes ?? []).some((v) => /^lokyy-(state|provision):/.test(v));
      if (uses || mountsState) assert.deepEqual(svc.depends_on?.['lokyy-init'], { condition: 'service_completed_successfully' }, name);
    }
  }
});

test('direct provisioning (LBV2-28 final): portal provisions MetaMCP itself; no watcher, no users file outside the portal', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const m = c.services.metamcp;
    assert.equal(m.image, 'ghcr.io/metatool-ai/metamcp:2.4.22');
    assert.equal(m.build, undefined);
    assert.equal(m.volumes, undefined);
    assert.ok(!Object.keys(m.environment ?? {}).some((k) => k.startsWith('MCP_TOKEN') || k.startsWith('MCP_READONLY')), 'metamcp needs no vault tokens');
    const p = c.services.portal;
    assert.deepEqual(netKeys(c, 'portal'), ['edge', 'metamcp-internal', 'portal', 'portal-gate']);
    const env = p.environment ?? {};
    assert.equal(env.METAMCP_URL, 'http://metamcp:12008');
    assert.equal(env.METAMCP_DATABASE_URL, c.services.metamcp.environment?.DATABASE_URL);
    for (const v of vaultNames(pkg)) assert.equal(env[`MCP_TOKEN_${v.toUpperCase()}`], c.services[`vault-${v}`].environment?.MCP_HTTP_TOKEN);
    assert.equal(env.MCP_READONLY_TOKEN_FIRMA, c.services['vault-firma'].environment?.MCP_HTTP_READONLY_TOKEN);
    assert.deepEqual(p.volumes, ['lokyy-state:/state']);
    assert.ok(!('lokyy-provision' in c.volumes));
    // users.json (mode 600) is read by nobody but the portal; the gate cap comes from the slot count
    const readers = Object.keys(c.services).filter((s) => (c.services[s].volumes ?? []).some((v) => v.startsWith('lokyy-state:')));
    assert.deepEqual(readers.sort(), ['lokyy-init', 'portal']);
    const g = c.services['mcp-gate'].environment ?? {};
    assert.equal(g.GATE_USERS_FILE, undefined);
    assert.equal(g.GATE_MAX_BINDINGS, String(Math.max(100, Math.ceil(slotNames(pkg).length * 20 * 1.25))));
  }
});

test('MED-3: least-privilege Authentik service account for the portal; no bootstrap token anywhere', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const b = renderBlueprint(pkg);
    for (const perm of ['view_user', 'add_user', 'change_user', 'delete_user', 'reset_user_password', 'view_group',
      'add_user_to_group', 'remove_user_from_group', 'view_authenticatedsession', 'delete_authenticatedsession']) {
      assert.ok(b.includes(`        - authentik_core.${perm}\n`), perm);
    }
    // + authentik_policies.view_policy (QA High: run the outpost session purge policy)
    assert.equal((b.match(/        - authentik_\w+\.\w+\n/g) ?? []).filter((l) => !l.includes('scopemapping')).length, 11, 'exactly 11 permissions');
    assert.ok(b.includes('      type: service_account\n'));
    assert.ok(b.includes('      key: !Env PORTAL_AUTHENTIK_TOKEN\n'));
    assert.ok(b.includes('      expiring: false\n') && b.includes('      intent: api\n'));
    const ak = c.services['authentik-worker'].environment ?? {};
    assert.equal(ak.PORTAL_AUTHENTIK_TOKEN, '${SERVICE_HEX_64_PORTALAKTOKEN}');
    assert.equal(ak.AUTHENTIK_BOOTSTRAP_TOKEN, undefined, 'no superuser API token');
    for (const [name, svc] of Object.entries(c.services)) {
      if (name.startsWith('authentik-')) continue;
      assert.ok(!JSON.stringify(svc).includes('SERVICE_HEX_64_PORTALAKTOKEN'), `${name} holds the service-account token`);
    }
  }
});

test('embed image carries the offline loader (no bind mounts)', () => {
  const df = readFileSync(join(coolifyDir, '../Dockerfile'), 'utf8');
  const embedStage = df.slice(df.indexOf(' AS embed\n'), df.indexOf('\nFROM ', df.indexOf(' AS embed\n')));
  assert.match(embedStage, /COPY deploy\/stack\/models\/offline\.mjs \/lokyy\/models\/offline\.mjs/);
});

test('authentik-gate (LBV2-28): only holder of the service-account token, two internal networks, fixed IPs', () => {
  for (const pkg of pkgs) {
    const c = buildCompose(pkg);
    const g = c.services['authentik-gate'];
    assert.deepEqual(g.build, { context: '../../deploy/stack/authentik-gate' });
    assert.equal(g.read_only, true);
    assert.deepEqual(g.cap_drop, ['ALL']);
    assert.equal(g.mem_limit, '128m');
    assert.equal(g.volumes, undefined);
    assert.equal(g.labels, undefined);
    assert.deepEqual(netKeys(c, 'authentik-gate'), ['authentik-api', 'portal-gate']);
    const on = (n: string) => Object.keys(c.services).filter((s) => netKeys(c, s).includes(n)).sort();
    assert.deepEqual(on('portal-gate'), ['authentik-gate', 'portal']);
    assert.deepEqual(on('authentik-api'), ['authentik-gate', 'authentik-server']);
    for (const n of ['portal-gate', 'authentik-api']) assert.equal(c.networks[n].internal, true, n);
    assert.equal(addr(c, 'authentik-server', 'authentik-api'), `${P}.0.140`);
    assert.equal(addr(c, 'authentik-gate', 'authentik-api'), `${P}.0.141`);
    assert.equal(addr(c, 'authentik-gate', 'portal-gate'), `${P}.0.124`);
    assert.equal(addr(c, 'portal', 'portal-gate'), `${P}.0.125`);
    const ge = g.environment ?? {};
    assert.equal(ge.AUTHENTIK_URL, `http://${P}.0.140:9000`);
    assert.equal(ge.AUTHENTIK_API_TOKEN, '${SERVICE_HEX_64_PORTALAKTOKEN}');
    assert.equal(ge.GATE_SECRET, '${SERVICE_HEX_64_PORTALGATESECRET}');
    const pe = c.services.portal.environment ?? {};
    assert.equal(pe.AUTHENTIK_GATE_URL, `http://${P}.0.124:8080`);
    assert.equal(pe.AUTHENTIK_GATE_SECRET, ge.GATE_SECRET);
    assert.equal(pe.AUTHENTIK_URL, undefined);
    assert.equal(pe.AUTHENTIK_API_TOKEN, undefined);
    assert.deepEqual(c.services.portal.depends_on?.['authentik-gate'], { condition: 'service_healthy' });
    for (const [name, svc] of Object.entries(c.services)) {
      if (['authentik-server', 'authentik-worker', 'authentik-gate'].includes(name)) continue;
      assert.ok(!JSON.stringify(svc).includes('SERVICE_HEX_64_PORTALAKTOKEN'), `${name} holds the service-account token`);
    }
  }
});

test('mandatory MFA for admins only (Oliver): policy-bound validation stage in the default authentication flow', () => {
  for (const pkg of pkgs) {
    const b = renderBlueprint(pkg);
    for (const dep of ['Default - Authentication flow', 'Default - TOTP MFA setup flow', 'Default - WebAuthn MFA setup flow', 'Default - Brand']) {
      assert.ok(b.includes(`attrs: { identifiers: { name: "${dep}" }, required: true }`), dep);
    }
    assert.ok(b.includes('model: authentik_stages_authenticator_validate.authenticatorvalidatestage'));
    assert.ok(b.includes('      device_classes: [totp, webauthn]'));
    assert.ok(b.includes('      not_configured_action: configure'));
    assert.ok(b.includes('!Find [authentik_stages_authenticator_totp.authenticatortotpstage, [name, default-authenticator-totp-setup]]'));
    assert.ok(b.includes('!Find [authentik_stages_authenticator_webauthn.authenticatorwebauthnstage, [name, default-authenticator-webauthn-setup]]'));
    assert.ok(b.includes('    identifiers: { target: !Find [authentik_flows.flow, [slug, default-authentication-flow]], stage: !KeyOf stage-admin-mfa, order: 35 }'));
    // also on the Lokyy login flow (the brand's), so no login path skips it
    assert.ok(b.includes('    identifiers: { target: !KeyOf flow-lokyy-authentication, stage: !KeyOf stage-admin-mfa, order: 35 }'));
    assert.ok(b.includes('    identifiers: { target: !KeyOf binding-admin-mfa-lokyy, policy: !KeyOf policy-admin-mfa }'));
    assert.ok(b.includes('      re_evaluate_policies: true'), 'decided when the user is known (after the password)');
    // the policy: superusers, lokyy-admins and "authentik Admins" only
    const expr = b.slice(b.indexOf('lokyy-admin-mfa-required'));
    for (const x of ['is_superuser', '"lokyy-admins"', '"authentik Admins"', 'pending_user']) assert.ok(expr.includes(x), x);
    assert.ok(b.includes('    identifiers: { target: !KeyOf binding-admin-mfa, policy: !KeyOf policy-admin-mfa }'));
  }
});

test('LOW-A: admin MFA policy bindings fail closed (failure_result: true): an exception in the expression never skips MFA', () => {
  for (const pkg of pkgs) {
    const lines = renderBlueprint(pkg).split('\n');
    const bindings = lines.flatMap((l, i) => (l.includes('policy: !KeyOf policy-admin-mfa }') && l.trimStart().startsWith('identifiers:') ? [i] : []));
    const positive = bindings.filter((i) => !/\bnegate: true\b/.test(lines[i + 1]));
    assert.equal(positive.length, 2, 'admin stage in the default flow + Lokyy login flow');
    for (const i of positive) assert.match(lines[i + 1], /^    attrs: \{.*\bfailure_result: true\b.*\}$/, lines[i + 1]);
    // failure_result covers only a PolicyException; for it the employee binding (failure_result not negated) is skipped
    for (const i of bindings.filter((j) => !positive.includes(j))) assert.match(lines[i + 1], /\bfailure_result: false\b/, lines[i + 1]);
  }
});

test('audit: admin MFA expression fails closed itself (any runtime error returns True: admin stage enforces, employee stage skips)', () => {
  // Authentik turns a runtime error inside an expression into PolicyResult(False) (not failure_result) and then
  // applies negate: without this, an admin without a device would log in without MFA.
  for (const pkg of pkgs) {
    const b = renderBlueprint(pkg);
    const start = b.indexOf('      expression: |\n', b.indexOf('name: lokyy-admin-mfa-required'));
    const rest = b.slice(start).split('\n').slice(1);
    const expr = rest.slice(0, rest.findIndex((l) => !l.startsWith('        '))).map((l) => l.slice(8));
    assert.equal(expr[0], 'try:', expr.join('\n'));
    assert.deepEqual(expr.slice(-2), ['except Exception:', '    return True'], expr.join('\n'));
    // every statement between try and except is inside the try block
    for (const l of expr.slice(1, -2)) assert.ok(l.startsWith('    '), l);
    assert.ok(!expr.some((l) => /return False/.test(l)));
  }
});

test('QA: exactly one MFA prompt on the Lokyy login flow (admins: lokyy-admin-mfa only, others: default validation only)', () => {
  for (const pkg of pkgs) {
    const b = renderBlueprint(pkg);
    const entries = b.split('\n  - model: ').slice(1);
    const validateBindings = entries.filter((e) => e.startsWith('authentik_flows.flowstagebinding')
      && e.includes('target: !KeyOf flow-lokyy-authentication')
      && (e.includes('authenticatorvalidatestage') || e.includes('stage: !KeyOf stage-admin-mfa')));
    assert.equal(validateBindings.length, 2, 'default MFA validation (30) + admin MFA (35)');
    const idOf = (e: string) => e.match(/\n    id: (\S+)/)?.[1] ?? assert.fail(`binding without id: ${e.slice(0, 200)}`);
    const policyBindings = (id: string) => entries.filter((e) => e.startsWith('authentik_policies.policybinding') && e.includes(`target: !KeyOf ${id},`));
    const byStage = Object.fromEntries(validateBindings.map((e) => [e.includes('stage-admin-mfa') ? 'admin' : 'default', idOf(e)]));
    // both gated by the same admin policy, one positive and one negated: mutually exclusive, so never two prompts
    const [adminPb] = policyBindings(byStage.admin);
    const [defaultPb, ...more] = policyBindings(byStage.default);
    assert.equal(more.length, 0);
    assert.ok(adminPb.includes('policy: !KeyOf policy-admin-mfa') && !adminPb.includes('negate: true'));
    assert.ok(defaultPb.includes('policy: !KeyOf policy-admin-mfa') && defaultPb.includes('negate: true'), defaultPb);
    const def = validateBindings.find((e) => idOf(e) === byStage.default) ?? '';
    assert.ok(def.includes('order: 30') && def.includes('evaluate_on_plan: false') && def.includes('re_evaluate_policies: true'), def);
    // enrolment only through the admin stage; the default validation stays optional (skip) for employees
    assert.ok(def.includes('default-authentication-mfa-validation'));
  }
});

test('QA High: outpost session purge policy; the portal role may only run (test) this one policy', () => {
  for (const pkg of pkgs) {
    const b = renderBlueprint(pkg);
    const entries = b.split('\n  - model: ').slice(1);
    const pol = entries.filter((e) => e.startsWith('authentik_policies_expression.expressionpolicy') && e.includes('identifiers: { name: lokyy-end-proxy-sessions }'));
    assert.equal(pol.length, 1);
    const e = pol[0];
    // refuses everyone the gate refuses, then deletes only this user's forward-auth sessions
    for (const x of ['request.user', 'is_superuser', '"lokyy_managed"', 'path != "lokyy"', '"lokyy-admins"', '"authentik Admins"',
      'from authentik.providers.proxy.models import ProxySession',
      // audit INFO-2: by user_id (UUID) or the sub claim, so a changed sub_mode still matches
      'ProxySession.objects.filter(Q(user_id=user.uuid) | Q(session_data__claims__sub=user.uid)).delete()']) {
      assert.ok(e.includes(x), x);
    }
    // The policy test API needs the global view_policy (an object permission crashes it in 2026.8.2 with
    // WrongAppError): the only policy permission of the portal role; no change/add/delete on policies
    const role = entries.find((x) => x.startsWith('authentik_rbac.role') && x.includes('name: lokyy-portal'))!;
    assert.deepEqual(role.split('\n').filter((l) => l.includes('authentik_policies')), ['        - authentik_policies.view_policy']);
  }
});

test('audit INFO-1: only lokyy-end-proxy-sessions writes; every other policy expression is side-effect free', () => {
  const WRITE = /\.(delete|save|update|create|bulk_create|bulk_update|get_or_create|update_or_create|set|add|remove|clear|set_password)\(/;
  const portal = readFileSync(join(coolifyDir, '../../apps/portal/authentik/lokyy-portal.yaml'), 'utf8');
  for (const b of [...pkgs.map(renderBlueprint), portal]) {
    const policies = b.split('\n  - model: ').slice(1).filter((e) => e.startsWith('authentik_policies_expression.expressionpolicy'));
    assert.ok(policies.length > 0);
    for (const e of policies) {
      const name = /identifiers: \{ name: ([^ }]+)/.exec(e)?.[1];
      const expr = e.slice(e.indexOf('expression: |'));
      if (name === 'lokyy-end-proxy-sessions') assert.equal((expr.match(new RegExp(WRITE.source, 'g')) ?? []).length, 1, 'exactly one delete');
      else assert.ok(!WRITE.test(expr), `${name} has a write call`);
    }
  }
});

test('brand (LBV2-35): user-visible names say "Lokyy Brain"; no old product name in deploy/coolify or the runbook', () => {
  const brand = /mind ?base|frankchu91|haobing|@mindbase\/mcp-server/gi;
  const allow = [/X-Mindbase-User/gi, /\bMINDBASE_[A-Z0-9_]+/g, /@mindbase\/(?!mcp-server)[a-z0-9-]+/g];
  const files = [...outputs().map((o) => o.content), readFileSync(join(coolifyDir, '../../docs/beta-runbook.md'), 'utf8'),
    readFileSync(join(coolifyDir, 'generate.ts'), 'utf8')];
  for (const text of files) {
    const clean = allow.reduce((t, re) => t.replace(re, ''), text);
    assert.deepEqual(clean.match(brand) ?? [], []);
  }
  for (const pkg of pkgs) {
    const b = renderBlueprint(pkg);
    assert.ok(b.includes('      branding_title: Lokyy Brain\n'), 'Authentik brand title');
    // Own login flow: the default flow's title is reset whenever "Default - Brand" re-applies it
    assert.ok(b.includes('    identifiers: { slug: lokyy-authentication }\n'));
    assert.ok(b.includes('      title: Lokyy Brain\n'), 'login flow title');
    assert.ok(b.includes('      flow_authentication: !KeyOf flow-lokyy-authentication\n'), 'brand uses the Lokyy login flow');
    assert.ok(!b.includes('identifiers: { slug: default-authentication-flow }'), 'never edit the default flow itself');
    for (const [order, stage] of [[10, 'default-authentication-identification'], [20, 'default-authentication-password'], [30, 'default-authentication-mfa-validation'], [100, 'default-authentication-login']] as const) {
      assert.ok(b.includes(`name, ${stage}]], order: ${order} }`), `${stage} at ${order}`);
    }
    for (const name of ['"Lokyy Brain · Vault v01"', '"Lokyy Brain · Firmen-Vault"', '"Lokyy Brain · Portal"', '"Lokyy Brain · MetaMCP Admin"']) {
      assert.ok(b.includes(`attrs: { name: ${name},`), name);
    }
    const c = buildCompose(pkg);
    for (const v of vaultNames(pkg)) {
      assert.deepEqual(c.services[`vault-${v}`].build?.args, { VITE_LOKYY_PORTAL_URL: 'https://app.${BASE_DOMAIN:?set BASE_DOMAIN in Coolify}' });
    }
  }
});
