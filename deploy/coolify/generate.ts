// LBV2-27 — generator for the Coolify packages (S = 15 vault slots, M = 30) from one template.
//
//   node deploy/coolify/generate.ts           write every generated file
//   node deploy/coolify/generate.ts --check   exit 1 if a committed file is stale
//
// Derived from the audited deploy/coolify/compose.yml of LBV2-16 and deploy/stack (same security model):
// per-vault internal web-<v>/mcp-<v> networks, egress with inter-container traffic off, mcp-gate in front
// of MetaMCP, MetaMCP on no vault network (only via vault-connector), read-only pinned models + offline
// loading, capture off, VAULT_LLM_ALLOWED_HOSTS, memory limits, X-Forwarded-Host pinning and one proxy
// secret per vault. Differences for Coolify "Raw" deployments (docs/beta-runbook.md):
//   - The only operator input is BASE_DOMAIN + ADMIN_EMAIL; every secret is a Coolify magic variable
//     (SERVICE_*), generated once by Coolify, persisted and shown in its UI.
//   - Repository assets (blueprint, Traefik routes, model manifest, init scripts) are baked into images:
//     no bind mounts into a checkout.
//   - The inner Traefik routes from a file provider (no Docker socket, no labels on inner services), so
//     coolify-proxy only ever sees the labels of lokyy-traefik, and the inner Traefik never sees Coolify's.
//   - Networks are project-scoped (no fixed names) with fixed /28 subnets from LOKYY_NET_PREFIX.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES = { s: { slots: 15 }, m: { slots: 30 } } as const;
export type PackageName = keyof typeof PACKAGES;
/** embed: shared embedding service of LBV2-26 (default on; off only for comparisons/tests). */
export interface GenerateOptions { embed?: boolean }

export interface Service {
  image?: string;
  build?: { context: string; dockerfile?: string; target?: string; args?: Record<string, string> };
  command?: string[];
  entrypoint?: string[];
  restart?: string;
  mem_limit?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  shm_size?: string;
  tmpfs?: string[];
  sysctls?: Record<string, string>;
  pids_limit?: number;
  cap_add?: string[];
  network_mode?: string;
  user?: string;
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  volumes?: string[];
  labels?: string[];
  healthcheck?: { test: string[]; interval: string; retries: number };
  networks?: string[] | Record<string, { aliases?: string[]; ipv4_address?: string }>;
  ports?: string[];
}
export interface Network {
  external?: boolean;
  internal?: boolean;
  driver?: string;
  driver_opts?: Record<string, string>;
  ipam?: { config: { subnet: string; ip_range?: string }[] };
}
export interface Compose {
  services: Record<string, Service>;
  networks: Record<string, Network>;
  volumes: Record<string, Record<string, never>>;
}

const REPO = '../..';
const NET = '${LOKYY_NET_PREFIX:-10.231}';
const DOMAIN = '${BASE_DOMAIN:?set BASE_DOMAIN in Coolify}';
const EMAIL = '${ADMIN_EMAIL:?set ADMIN_EMAIL in Coolify}';
// Outside the dynamic ip_range of mcp-upstream: a recreated metamcp can never take the connector's address
const CONNECTOR_IP = `${NET}.0.62`;
const EMBED_PORT = 8080;
// Fixed addresses on the portal network (outside its dynamic ip_range .80/29): the portal-admin entrypoint
// listens only on Traefik's address there, and only the portal's address may use it.
const TRAEFIK_PORTAL_IP = `${NET}.0.93`;
const PORTAL_IP = `${NET}.0.94`;
// authentik-gate (LBV2-28): portal-gate (portal <-> gate) and authentik-api (gate <-> authentik-server)
const GATE_PORTAL_IP = `${NET}.0.124`;
const PORTAL_GATE_IP = `${NET}.0.125`;
const AUTHENTIK_API_IP = `${NET}.0.140`;
const GATE_API_IP = `${NET}.0.141`;
/** Fixed addresses on embed-<v>: the embed service (.46) and the vault (.45), outside ip_range .32/29. */
const embedNetIp = (v: string, host: 45 | 46) => `${NET}.${2 + (v === 'firma' ? 0 : Number(v.slice(1)))}.${host}`;
// HIGH-1: lokyy-traefik sits on the shared "coolify" network, where any other Coolify app could register a
// container or alias named like one of ours and win Docker's DNS answer. So every upstream of the inner
// Traefik is a fixed address outside the dynamic ip_range (.0/29) of its network, never a name.
const EDGE_IP = { 'authentik-server': `${NET}.0.10`, metamcp: `${NET}.0.11`, 'mcp-gate': `${NET}.0.12` } as const;
const VAULT_HOST = 14;

export const slotNames = (pkg: PackageName): string[] =>
  Array.from({ length: PACKAGES[pkg].slots }, (_, i) => `v${String(i + 1).padStart(2, '0')}`);
export const vaultNames = (pkg: PackageName): string[] => [...slotNames(pkg), 'firma'];

// Coolify magic variables: identifiers are upper-case ASCII letters and digits only.
const id = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const magic = {
  hex: (name: string) => `\${SERVICE_HEX_64_${id(name)}}`,
  password: (name: string) => `\${SERVICE_PASSWORD_${id(name)}}`,
};
const secret = {
  mcpToken: (v: string) => magic.hex(`mcp${v}`),
  mcpReadonlyFirma: magic.hex('mcpreadonlyfirma'),
  proxy: (v: string) => magic.hex(`proxy${v}`),
  portalProxy: magic.hex('proxyportal'),
  authentikSecret: magic.hex('authentiksecret'),
  authentikDb: magic.hex('authentikdb'),
  portalAuthentikToken: magic.hex('portalaktoken'),
  portalGateSecret: magic.hex('portalgatesecret'),
  adminPassword: magic.password('admin'),
  metamcpDb: magic.hex('metamcpdb'),
  metamcpAuth: magic.hex('metamcpauth'),
  metamcpAdmin: magic.password('metamcpadmin'),
  // alphanumeric: the embed service wants >= 16 distinct characters, hex would miss that ~25% of the time
  embedToken: (v: string) => `\${SERVICE_PASSWORD_64_${id(`emb${v}`)}}`,
};

/** /28 per network; slot k (1-based, firma = 0) gets <prefix>.<2+k>.0/28 (web) and .16/28 (mcp). */
function subnet(name: string): string {
  const fixed: Record<string, string> = {
    edge: '0.0/28', 'authentik-internal': '0.16/28', 'metamcp-internal': '0.32/28', 'mcp-upstream': '0.48/28',
    'model-egress': '0.64/28', portal: '0.80/28', egress: '1.0/26', 'portal-gate': '0.112/28', 'authentik-api': '0.128/28',
  };
  if (fixed[name]) return `${NET}.${fixed[name]}`;
  const m = /^(web|mcp|embed)-(v(\d+)|firma)$/.exec(name);
  if (!m) throw new Error(`no subnet for ${name}`);
  const k = m[2] === 'firma' ? 0 : Number(m[3]);
  return `${NET}.${2 + k}.${{ web: 0, mcp: 16, embed: 32 }[m[1] as 'web' | 'mcp' | 'embed']}/28`;
}
const network = (name: string, extra: Network = {}): Network => ({ ...extra, ipam: { config: [{ subnet: subnet(name) }] } });
/** Network whose lower half (.0/29) is the dynamic range; fixed addresses live in the upper half. */
const splitNetwork = (name: string, extra: Network = {}): Network => {
  const sub = subnet(name);
  return { ...extra, ipam: { config: [{ subnet: sub, ip_range: sub.replace(/\/28$/, '/29') }] } };
};
/** Fixed address of vault <v> on its web-<v> network (and the dynamic.yml template form). */
const vaultIp = (v: string, net = NET) => `${net}.${2 + (v === 'firma' ? 0 : Number(v.slice(1)))}.${VAULT_HOST}`;

function vault(v: string, opts: GenerateOptions): Service {
  const env: Record<string, string> = {
    MCP_HTTP_PORT: '4322',
    MINDBASE_MDNS: 'off',
    // Beta decision: no capture / device pairing on hosted vaults
    MINDBASE_DISABLE_CAPTURE: '1',
    // LBV2-19: guarded vaults only call LLM hosts on this list
    VAULT_LLM_ALLOWED_HOSTS: 'api.eurouter.ai',
    // Persistent per-vault cache for tesseract language data (/models is read-only and shared)
    MINDBASE_MODEL_CACHE: '/home/vault',
    // LBV2-24: transformers.js never downloads in a vault, only the verified /models cache is used
    NODE_OPTIONS: '--import=/lokyy/models/offline.mjs',
    MINDBASE_MODELS_OFFLINE: '1',
    MCP_HTTP_TOKEN: secret.mcpToken(v),
    MCP_HTTP_ALLOWED_HOSTS: `mcp.vault-${v}:4322`,
    VAULT_PROXY_SECRET: secret.proxy(v),
    // A personal slot's owner administers their own vault; the company vault only the operators
    VAULT_ADMIN_GROUPS: v === 'firma' ? 'lokyy-admins' : `vault-${v},lokyy-admins`,
  };
  // Readers of the company vault (group vault-firma-read) get this token via MetaMCP: read tools only
  if (v === 'firma') env.MCP_HTTP_READONLY_TOKEN = secret.mcpReadonlyFirma;
  const base: Service = {
    // The vault UI links "connect AI clients" to the setup portal (LBV2-35)
    build: { context: REPO, dockerfile: 'deploy/Dockerfile', args: { VITE_LOKYY_PORTAL_URL: `https://app.${DOMAIN}` } },
    restart: 'unless-stopped',
    environment: env,
    networks: { [`web-${v}`]: { ipv4_address: vaultIp(v) }, [`mcp-${v}`]: { aliases: [`upstream.vault-${v}`] }, egress: {} },
  };
  if (opts.embed) {
    // LBV2-26: embeddings from the shared service over the vault's own embed-<v> network, own token;
    // the vault no longer loads or mounts the model (measured vault peak 226 MiB)
    // Fixed address, like every other hop (HIGH-1)
    env.MINDBASE_EMBED_URL = `http://${embedNetIp(v, 46)}:${EMBED_PORT}`;
    env.MINDBASE_EMBED_TOKEN = secret.embedToken(v);
    return {
      ...base,
      mem_limit: '${VAULT_MEM_LIMIT:-1g}',
      depends_on: { embed: { condition: 'service_healthy' } },
      volumes: [`vault-${v}:/data`, `vault-${v}-home:/home/vault`],
      networks: { ...base.networks, [`embed-${v}`]: { ipv4_address: embedNetIp(v, 45) } },
    };
  }
  return {
    ...base,
    // LBV2-20: idle ~200 MiB, peak 2.62 GiB with bge-m3 loaded
    mem_limit: '${VAULT_MEM_LIMIT:-3500m}',
    depends_on: { 'model-prefetch': { condition: 'service_completed_successfully' } },
    volumes: [`vault-${v}:/data`, 'models:/models:ro', `vault-${v}-home:/home/vault`],
  };
}

export function buildCompose(pkg: PackageName, options: GenerateOptions = {}): Compose {
  const opts: GenerateOptions = { embed: true, ...options };
  const vaults = vaultNames(pkg);
  const hosts = ['auth', 'mcp', 'app', ...vaults];
  const services: Record<string, Service> = {};

  // coolify-proxy labels: one TLS router (own HTTP-01 certificate) per public host, one HTTP->HTTPS
  // redirect router for all of them. Only this container carries traefik.* labels.
  // MED-2: router/middleware/service names are global in coolify-proxy: unique per Coolify resource
  const id = (n: string) => `lokyy-\${COOLIFY_RESOURCE_UUID:-local}-${n}`;
  const labels = ['traefik.enable=true', 'traefik.docker.network=coolify'];
  for (const h of hosts) {
    const r = id(h);
    labels.push(
      `traefik.http.routers.${r}.rule=Host(\`${h}.\${BASE_DOMAIN}\`)`,
      `traefik.http.routers.${r}.entrypoints=https`,
      `traefik.http.routers.${r}.tls=true`,
      `traefik.http.routers.${r}.tls.certresolver=letsencrypt`,
      `traefik.http.routers.${r}.service=${id('inner')}`,
    );
  }
  labels.push(
    `traefik.http.routers.${id('http')}.rule=${hosts.map((h) => `Host(\`${h}.\${BASE_DOMAIN}\`)`).join(' || ')}`,
    `traefik.http.routers.${id('http')}.entrypoints=http`,
    `traefik.http.routers.${id('http')}.middlewares=${id('to-https')}`,
    `traefik.http.routers.${id('http')}.service=${id('inner')}`,
    `traefik.http.middlewares.${id('to-https')}.redirectscheme.scheme=https`,
    `traefik.http.middlewares.${id('to-https')}.redirectscheme.permanent=true`,
    `traefik.http.services.${id('inner')}.loadbalancer.server.port=80`,
  );
  const traefikEnv: Record<string, string> = {
    BASE_DOMAIN: DOMAIN, NET_PREFIX: NET, PROXY_SECRET_PORTAL: secret.portalProxy, PORTAL_IP,
    // MED-1: empty = trust X-Forwarded-* only from the subnet of the coolify network (entrypoint.sh)
    LOKYY_TRUSTED_PROXY_CIDRS: '${LOKYY_TRUSTED_PROXY_CIDRS:-}',
  };
  for (const v of vaults) traefikEnv[`PROXY_SECRET_${v.toUpperCase()}`] = secret.proxy(v);
  services['lokyy-traefik'] = {
    build: { context: REPO, dockerfile: 'deploy/coolify/traefik/Dockerfile', args: { LOKYY_PACKAGE: pkg } },
    restart: 'unless-stopped',
    mem_limit: '256m',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    command: [
      '--providers.file.filename=/etc/lokyy/dynamic.yml',
      '--entrypoints.web.address=:80',
      // forwardedHeaders.trustedIPs is appended by entrypoint.sh: the coolify network's subnet (coolify-proxy
      // and other Coolify apps), never our own networks; Host and Proto are pinned per router anyway.
      // X_authentik_username / X.Authentik.Username must not alias a managed header in WSGI-style backends
      '--entrypoints.web.http.aliasheadersstrategy=delete',
      // Vault config API for the portal (LBV2-28): only on Traefik's address in the portal network, so no
      // other container (Authentik, MetaMCP, gate, vaults) can reach it
      `--entrypoints.portal-admin.address=${TRAEFIK_PORTAL_IP}:8090`,
      '--api.dashboard=false',
      '--log.level=INFO',
    ],
    environment: traefikEnv,
    labels,
    networks: {
      coolify: {}, edge: {}, portal: { ipv4_address: TRAEFIK_PORTAL_IP },
      ...Object.fromEntries(vaults.map((v) => [`web-${v}`, {}])),
    },
  };

  // ---------------------------------------------------------------- Authentik
  services['authentik-db'] = {
    image: 'postgres:16-alpine',
    restart: 'unless-stopped',
    mem_limit: '512m',
    environment: { POSTGRES_DB: 'authentik', POSTGRES_USER: 'authentik', POSTGRES_PASSWORD: secret.authentikDb },
    volumes: ['authentik-db:/var/lib/postgresql/data'],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -d authentik -U authentik'], interval: '10s', retries: 10 },
    networks: ['authentik-internal'],
  };
  const authentikEnv: Record<string, string> = {
    AUTHENTIK_POSTGRESQL__HOST: 'authentik-db',
    AUTHENTIK_POSTGRESQL__NAME: 'authentik',
    AUTHENTIK_POSTGRESQL__USER: 'authentik',
    AUTHENTIK_POSTGRESQL__PASSWORD: secret.authentikDb,
    AUTHENTIK_SECRET_KEY: secret.authentikSecret,
    // First start: user akadmin with this e-mail and password (password shown in Coolify's env list);
    // the blueprint puts akadmin into lokyy-admins. No bootstrap API token (superuser) is created.
    AUTHENTIK_BOOTSTRAP_EMAIL: EMAIL,
    AUTHENTIK_BOOTSTRAP_PASSWORD: secret.adminPassword,
    // Key of the portal's least-privilege service-account token (blueprint lokyy-portal-api)
    PORTAL_AUTHENTIK_TOKEN: secret.portalAuthentikToken,
    AUTHENTIK_ERROR_REPORTING__ENABLED: 'false',
    AUTHENTIK_DISABLE_UPDATE_CHECK: 'true',
    AUTHENTIK_DISABLE_STARTUP_ANALYTICS: 'true',
    BASE_DOMAIN: DOMAIN,
  };
  const authentik = (cmd: string, networks: string[]): Service => ({
    build: { context: REPO, dockerfile: 'deploy/coolify/authentik/Dockerfile', args: { LOKYY_PACKAGE: pkg } },
    restart: 'unless-stopped',
    command: [cmd],
    mem_limit: '1g',
    depends_on: { 'authentik-db': { condition: 'service_healthy' } },
    environment: authentikEnv,
    shm_size: '512mb',
    networks,
  });
  services['authentik-server'] = {
    ...authentik('server', []),
    networks: { edge: { ipv4_address: EDGE_IP['authentik-server'] }, 'authentik-internal': {}, 'authentik-api': { ipv4_address: AUTHENTIK_API_IP } },
  };
  services['authentik-worker'] = authentik('worker', ['authentik-internal']);
  // The blueprint is baked into the image: a changed package recreates the worker, whose startup discovery
  // applies the changed file (M: ~6 min until the new slots route). Never add a second applier (e.g.
  // `ak apply_blueprint` in another container): concurrent applies deadlock in Postgres.

  // -------------------------------------------------------------------- Portal
  // Setup portal (LBV2-28, apps/portal). Writes users.json into lokyy-state (the only writer). Reaches
  // Authentik's API and the internet (EUrouter model list) over edge, vault config only via lokyy-traefik's
  // portal-admin entrypoint; never on a vault network.
  services.portal = {
    build: { context: REPO, dockerfile: 'apps/portal/Dockerfile' },
    restart: 'unless-stopped',
    mem_limit: '256m',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    environment: {
      PORT: '3000',
      LOKYY_DOMAIN: DOMAIN,
      LOKYY_PACKAGE: pkg,
      LOKYY_SLOTS: slotNames(pkg).join(','),
      LOKYY_STATE_DIR: '/state',
      // No Authentik token: users and groups only through authentik-gate (shared secret)
      AUTHENTIK_GATE_URL: `http://${GATE_PORTAL_IP}:8080`,
      AUTHENTIK_GATE_SECRET: secret.portalGateSecret,
      VAULT_PROXY_SECRET: secret.portalProxy,
      VAULT_ADMIN_URL: `http://${TRAEFIK_PORTAL_IP}:8090`,
      // Direct provisioning (LBV2-28): MetaMCP API + database, vault tokens for the users' MCP servers
      METAMCP_URL: 'http://metamcp:12008',
      METAMCP_DATABASE_URL: `postgresql://metamcp:${secret.metamcpDb}@metamcp-db:5432/metamcp`,
      ...Object.fromEntries(vaults.map((v) => [`MCP_TOKEN_${v.toUpperCase()}`, secret.mcpToken(v)])),
      MCP_READONLY_TOKEN_FIRMA: secret.mcpReadonlyFirma,
    },
    volumes: ['lokyy-state:/state'],
    depends_on: { 'authentik-gate': { condition: 'service_healthy' } },
    networks: { edge: {}, portal: { ipv4_address: PORTAL_IP }, 'metamcp-internal': {}, 'portal-gate': { ipv4_address: PORTAL_GATE_IP } },
  };
  // authentik-gate (LBV2-28): the only holder of the portal's least-privilege Authentik token. Reachable
  // only from the portal (portal-gate), reaches only authentik-server (authentik-api); no egress.
  services['authentik-gate'] = {
    build: { context: `${REPO}/deploy/stack/authentik-gate` },
    restart: 'unless-stopped',
    mem_limit: '128m',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    depends_on: { 'authentik-server': { condition: 'service_healthy' } },
    environment: {
      AUTHENTIK_URL: `http://${AUTHENTIK_API_IP}:9000`,
      AUTHENTIK_API_TOKEN: secret.portalAuthentikToken,
      GATE_SECRET: secret.portalGateSecret,
    },
    networks: { 'portal-gate': { ipv4_address: GATE_PORTAL_IP }, 'authentik-api': { ipv4_address: GATE_API_IP } },
  };

  // -------------------------------------------------------------------- Vaults
  // One-shot: fills the shared model cache (pinned revision, SHA-256 per file); vaults mount it read-only.
  services['model-prefetch'] = {
    // Same build arguments as the vaults: one image build shared through the cache
    build: { context: REPO, dockerfile: 'deploy/Dockerfile', args: { VITE_LOKYY_PORTAL_URL: `https://app.${DOMAIN}` } },
    restart: 'no',
    entrypoint: ['node', '/lokyy/models/prefetch.mjs'],
    volumes: ['models:/models'],
    networks: ['model-egress'],
  };
  for (const v of vaults) services[`vault-${v}`] = vault(v, opts);

  if (opts.embed) {
    // LBV2-26: one BGE-M3 for all vaults, only on the embed-<v> networks (one per vault, no egress). A
    // vault's token is accepted only from its own network (EMBED_SOURCE_<V>). Plain tokens (magic
    // variables) are hashed by the service at startup.
    const embedEnv: Record<string, string> = { EMBED_VAULTS: vaults.join(',') };
    for (const v of vaults) {
      embedEnv[`EMBED_TOKEN_${v.toUpperCase()}`] = secret.embedToken(v);
      embedEnv[`EMBED_SOURCE_${v.toUpperCase()}`] = subnet(`embed-${v}`);
    }
    services.embed = {
      build: { context: REPO, dockerfile: 'deploy/Dockerfile', target: 'embed' },
      restart: 'unless-stopped',
      mem_limit: '${EMBED_MEM_LIMIT:-4g}',
      read_only: true,
      tmpfs: ['/tmp:size=16m,mode=1777'],
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      // Joined to every embed-<v> network: never route between them
      sysctls: { 'net.ipv4.ip_forward': '0' },
      pids_limit: 256,
      depends_on: { 'model-prefetch': { condition: 'service_completed_successfully' } },
      // Second layer on top of the service's own offline configuration (baked into the embed image)
      environment: { ...embedEnv, NODE_OPTIONS: '--import=/lokyy/models/offline.mjs' },
      volumes: ['models:/models:ro'],
      networks: Object.fromEntries(vaults.map((v) => [`embed-${v}`, { ipv4_address: embedNetIp(v, 46) }])),
    };
  }

  // ------------------------------------------------------------------- MetaMCP
  services['metamcp-db'] = {
    image: 'postgres:16-alpine',
    restart: 'unless-stopped',
    mem_limit: '512m',
    environment: { POSTGRES_DB: 'metamcp', POSTGRES_USER: 'metamcp', POSTGRES_PASSWORD: secret.metamcpDb },
    volumes: ['metamcp-db:/var/lib/postgresql/data'],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -d metamcp -U metamcp'], interval: '10s', retries: 10 },
    networks: ['metamcp-internal'],
  };
  const metamcpEnv: Record<string, string> = {
    DATABASE_URL: `postgresql://metamcp:${secret.metamcpDb}@metamcp-db:5432/metamcp`,
    POSTGRES_HOST: 'metamcp-db',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'metamcp',
    POSTGRES_PASSWORD: secret.metamcpDb,
    POSTGRES_DB: 'metamcp',
    APP_URL: `https://mcp.${DOMAIN}`,
    NEXT_PUBLIC_APP_URL: `https://mcp.${DOMAIN}`,
    BETTER_AUTH_SECRET: secret.metamcpAuth,
    TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL: 'false',
  };
  services.metamcp = {
    image: 'ghcr.io/metatool-ai/metamcp:2.4.22',
    restart: 'unless-stopped',
    mem_limit: '1536m',
    depends_on: { 'metamcp-db': { condition: 'service_healthy' } },
    environment: metamcpEnv,
    // No vault network: vaults are reached only through vault-connector. edge is not internal (MetaMCP
    // itself needs no internet; the edge network has it for Authentik and the portal)
    networks: { edge: { ipv4_address: EDGE_IP.metamcp }, 'metamcp-internal': {}, 'mcp-upstream': {} },
  };
  const gateBase: Service = {
    build: { context: `${REPO}/deploy/stack/mcp-gate` },
    restart: 'unless-stopped',
    mem_limit: '128m',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
  };
  // Session-binding proxy for MCP clients; session cap from the users file the portal writes.
  services['mcp-gate'] = {
    ...gateBase,
    // users.json is the portal's private file (mode 600): the session cap comes from the package size,
    // LBV2-24 formula users x 20 x 1.25 (at least 100) with one user per slot
    environment: { MODE: 'gate', GATE_UPSTREAM: 'http://metamcp:12008', GATE_MAX_BINDINGS: String(Math.max(100, Math.ceil(slotNames(pkg).length * 20 * 1.25))) },
    depends_on: { metamcp: { condition: 'service_healthy' } },
    networks: { edge: { ipv4_address: EDGE_IP['mcp-gate'] } },
  };
  // One-way path MetaMCP -> vaults; listens only on its fixed mcp-upstream address, routes by Host.
  const connectorNets: Record<string, { aliases?: string[]; ipv4_address?: string }> = {
    'mcp-upstream': { ipv4_address: CONNECTOR_IP, aliases: vaults.map((v) => `mcp.vault-${v}`) },
  };
  for (const v of vaults) connectorNets[`mcp-${v}`] = {};
  services['vault-connector'] = {
    ...gateBase,
    environment: { MODE: 'connector', CONNECTOR_VAULTS: vaults.join(','), CONNECTOR_LISTEN_HOST: CONNECTOR_IP },
    networks: connectorNets,
  };
  // One-shot: creates the MetaMCP admin, closes self-registration, sets the session lifetime.
  services['metamcp-init'] = {
    build: { context: REPO, dockerfile: 'deploy/coolify/metamcp-init/Dockerfile' },
    restart: 'no',
    depends_on: { metamcp: { condition: 'service_healthy' } },
    environment: {
      PGHOST: 'metamcp-db', PGUSER: 'metamcp', PGDATABASE: 'metamcp', PGPASSWORD: secret.metamcpDb,
      METAMCP_ADMIN_EMAIL: EMAIL, METAMCP_ADMIN_PASS: secret.metamcpAdmin,
    },
    networks: ['metamcp-internal'],
  };

  // ------------------------------------------------------------------ Networks
  const networks: Record<string, Network> = {
    coolify: { external: true },
    edge: splitNetwork('edge'),
    'authentik-internal': network('authentik-internal', { internal: true }),
    'metamcp-internal': network('metamcp-internal', { internal: true }),
    'mcp-upstream': { internal: true, ipam: { config: [{ subnet: subnet('mcp-upstream'), ip_range: `${NET}.0.48/29` }] } },
    portal: { internal: true, ipam: { config: [{ subnet: subnet('portal'), ip_range: `${NET}.0.80/29` }] } },
    'portal-gate': { internal: true, ipam: { config: [{ subnet: subnet('portal-gate'), ip_range: `${NET}.0.112/29` }] } },
    'authentik-api': { internal: true, ipam: { config: [{ subnet: subnet('authentik-api'), ip_range: `${NET}.0.128/29` }] } },
    'model-egress': network('model-egress'),
    egress: network('egress', { driver: 'bridge', driver_opts: { 'com.docker.network.bridge.enable_icc': 'false' } }),
  };
  for (const v of vaults) {
    networks[`web-${v}`] = splitNetwork(`web-${v}`, { internal: true });
    networks[`mcp-${v}`] = network(`mcp-${v}`, { internal: true });
    if (opts.embed) networks[`embed-${v}`] = splitNetwork(`embed-${v}`, { internal: true });
  }

  const volumes: Record<string, Record<string, never>> = { 'authentik-db': {}, 'metamcp-db': {}, models: {}, 'lokyy-state': {} };
  for (const v of vaults) { volumes[`vault-${v}`] = {}; volumes[`vault-${v}-home`] = {}; }

  // LOW-1: one-shot check of the operator input before anything uses it (Traefik rules, blueprint, SQL in
  // metamcp-init), and ownership of the portal's state volume (uid 1000) before the portal mounts it.
  services['lokyy-init'] = {
    build: { context: REPO, dockerfile: 'deploy/coolify/metamcp-init/Dockerfile' },
    restart: 'no',
    entrypoint: ['/lokyy/init-check.sh'],
    user: '0',
    cap_drop: ['ALL'],
    cap_add: ['CHOWN', 'FOWNER'],
    security_opt: ['no-new-privileges:true'],
    network_mode: 'none',
    environment: { BASE_DOMAIN: DOMAIN, ADMIN_EMAIL: EMAIL },
    volumes: ['lokyy-state:/state'],
  };
  const usesInput = (svc: Service) => JSON.stringify(svc).match(/\$\{(BASE_DOMAIN|ADMIN_EMAIL)|"lokyy-state:/);
  for (const [name, svc] of Object.entries(services)) {
    if (name !== 'lokyy-init' && usesInput(svc)) svc.depends_on = { ...svc.depends_on, 'lokyy-init': { condition: 'service_completed_successfully' } };
  }
  return { services, networks, volumes };
}

// --------------------------------------------------------------------- YAML
const key = (k: string) => (/^[A-Za-z0-9_.\/-]+$/.test(k) ? k : JSON.stringify(k));
const scalar = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
function yaml(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return ' []\n';
    return '\n' + v.map((x) => `${indent}-${isObj(x) ? yaml(x, indent + '  ').replace(/^\n\s*/, ' ') : ' ' + scalar(x) + '\n'}`).join('');
  }
  if (isObj(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return ' {}\n';
    return '\n' + entries.map(([k, x]) => `${indent}${key(k)}:${isObj(x) || Array.isArray(x) ? yaml(x, indent + '  ') : ' ' + scalar(x) + '\n'}`).join('');
  }
  return ' ' + scalar(v) + '\n';
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const HEADER = (pkg: PackageName, what: string) =>
  `# GENERATED by deploy/coolify/generate.ts — do not edit. Package ${pkg.toUpperCase()} (${PACKAGES[pkg].slots} vault slots + firma): ${what}\n`;

export function renderCompose(pkg: PackageName, opts: GenerateOptions = {}): string {
  const c = buildCompose(pkg, opts);
  return HEADER(pkg, 'Coolify "Docker Compose" build pack, Raw mode ON, "Connect to predefined network" OFF.') +
    '# Operator input: BASE_DOMAIN, ADMIN_EMAIL. Everything else is generated (docs/beta-runbook.md).\n' +
    `# Hosts: auth. mcp. app. firma. ${slotNames(pkg)[0]}.–${slotNames(pkg).at(-1)}.<BASE_DOMAIN> (wildcard DNS *.<BASE_DOMAIN>).\n` +
    yaml(c).replace(/^\n/, '');
}

// Inner Traefik routes (file provider, Go template: BASE_DOMAIN and proxy secrets come from its env).
export function renderTraefikDynamic(pkg: PackageName): string {
  const vaults = vaultNames(pkg);
  const L: string[] = [];
  const pin = (name: string, host: string) => [
    `    ${name}-fwd:`,
    '      headers:',
    '        customRequestHeaders:',
    `          X-Forwarded-Host: "${host}.{{ $d }}"`,
    '          X-Forwarded-Proto: "https"',
  ];
  const guarded = (name: string, host: string, service: string, extra: string[] = []) => [
    `    ${name}:`,
    `      rule: "Host(\`${host}.{{ $d }}\`)"`,
    '      entryPoints: ["web"]',
    `      middlewares: [${[`"${name}-fwd"`, '"authentik"', ...extra].join(', ')}]`,
    `      service: "${service}"`,
    `    ${name}-outpost:`,
    `      rule: "Host(\`${host}.{{ $d }}\`) && PathPrefix(\`/outpost.goauthentik.io/\`)"`,
    '      entryPoints: ["web"]',
    `      middlewares: ["${name}-fwd"]`,
    '      service: "authentik"',
  ];
  L.push(HEADER(pkg, 'inner Traefik routes (lokyy-traefik file provider).').trimEnd());
  L.push('{{ $d := env `BASE_DOMAIN` }}{{ $n := env `NET_PREFIX` }}');
  L.push('http:', '  routers:');
  L.push('    authentik:', '      rule: "Host(`auth.{{ $d }}`)"', '      entryPoints: ["web"]', '      middlewares: ["auth-fwd"]', '      service: "authentik"');
  for (const v of vaults) {
    const r = guarded(`vault-${v}`, v, `vault-${v}`, ['"vault-identity"', `"vault-${v}-secret"`]);
    L.push(...r);
  }
  L.push(...guarded('portal', 'app', 'portal', ['"vault-identity"', '"portal-secret"']));
  // Portal-admin entrypoint (LBV2-28): the portal changes a vault's LLM configuration. Only the config API,
  // only from the portal's address, with a fixed operator identity and that vault's proxy secret.
  for (const v of vaults) {
    L.push(
      `    vault-${v}-admin:`,
      `      rule: "(Path(\`/${v}/api/config\`) && (Method(\`GET\`) || Method(\`PUT\`))) || (Path(\`/${v}/api/config/test\`) && Method(\`POST\`))"`,
      '      entryPoints: ["portal-admin"]',
      `      middlewares: ["portal-only", "vault-${v}-admin-strip", "vault-${v}-admin-hdr"]`,
      `      service: "vault-${v}"`,
    );
  }
  // MetaMCP admin UI behind Authentik (lokyy-admins); /metamcp/* is never served by the admin router
  L.push(
    '    metamcp:',
    '      rule: "Host(`mcp.{{ $d }}`) && !PathPrefix(`/metamcp/`)"',
    '      entryPoints: ["web"]',
    '      middlewares: ["metamcp-fwd", "authentik"]',
    '      service: "metamcp"',
    '    metamcp-outpost:',
    '      rule: "Host(`mcp.{{ $d }}`) && PathPrefix(`/outpost.goauthentik.io/`)"',
    '      entryPoints: ["web"]',
    '      middlewares: ["metamcp-fwd"]',
    '      service: "authentik"',
    // MCP endpoints: API keys, no forward-auth; only through mcp-gate
    '    metamcp-endpoints:',
    '      rule: "Host(`mcp.{{ $d }}`) && PathRegexp(`^/metamcp/[a-z0-9-]+/mcp$`)"',
    '      entryPoints: ["web"]',
    '      priority: 100',
    '      middlewares: ["metamcp-ratelimit", "metamcp-uniform-errors"]',
    '      service: "mcp-gate"',
  );
  L.push('  middlewares:');
  L.push(
    '    authentik:',
    '      forwardAuth:',
    '        address: "http://{{ $n }}.0.10:9000/outpost.goauthentik.io/auth/traefik"',
    '        trustForwardHeader: true',
    '        maxResponseBodySize: 1048576',
    // authResponseHeaders are deleted from the client request and replaced by Authentik's values
    '        authResponseHeaders: ["X-authentik-username", "X-authentik-groups", "X-authentik-email", "X-authentik-uid"]',
    // Defence in depth: legacy attribution header never reaches a vault from a client
    '    vault-identity:',
    '      headers:',
    '        customRequestHeaders:',
    '          X-Mindbase-User: ""',
  );
  for (const v of vaults) {
    L.push(...pin(`vault-${v}`, v));
    // Overwrites any client-supplied value; only this router carries this vault's secret
    L.push(`    vault-${v}-secret:`, '      headers:', '        customRequestHeaders:',
      `          X-Vault-Proxy-Secret: "{{ env \`PROXY_SECRET_${v.toUpperCase()}\` }}"`);
  }
  L.push('    portal-only:', '      ipAllowList:', '        sourceRange: ["{{ env `PORTAL_IP` }}/32"]');
  for (const v of vaults) {
    L.push(
      `    vault-${v}-admin-strip:`, '      stripPrefix:', `        prefixes: ["/${v}"]`,
      `    vault-${v}-admin-hdr:`, '      headers:', '        customRequestHeaders:',
      `          X-Vault-Proxy-Secret: "{{ env \`PROXY_SECRET_${v.toUpperCase()}\` }}"`,
      // Overwrites whatever the caller sent: the portal acts as operator "lokyy-portal"
      '          X-authentik-username: "lokyy-portal"',
      '          X-authentik-groups: "lokyy-admins"',
      '          X-authentik-email: ""',
      '          X-authentik-uid: ""',
      '          X-Mindbase-User: ""',
    );
  }
  L.push(...pin('auth', 'auth'));
  L.push(...pin('portal', 'app'));
  L.push('    portal-secret:', '      headers:', '        customRequestHeaders:',
    '          X-Vault-Proxy-Secret: "{{ env `PROXY_SECRET_PORTAL` }}"');
  L.push(...pin('metamcp', 'mcp'));
  L.push(
    '    metamcp-ratelimit:',
    '      rateLimit:',
    '        average: 20',
    '        burst: 60',
    // Behind coolify-proxy the TCP peer is always the proxy: bucket per real client (right-most XFF entry)
    '        sourceCriterion:',
    '          ipStrategy:',
    '            depth: 1',
    '    metamcp-uniform-errors:',
    '      errors:',
    '        status: ["400-428", "430-599"]',
    '        service: "mcp-gate"',
    '        query: "/__error"',
    '        statusRewrites:',
    '          "403": 401',
    '          "404": 401',
  );
  L.push('  services:');
  const svc = (name: string, url: string) => [`    ${name}:`, '      loadBalancer:', '        servers:', `          - url: "${url}"`];
  // Fixed addresses, never names (HIGH-1); they match EDGE_IP / vaultIp / PORTAL_IP in the compose file
  L.push(...svc('authentik', 'http://{{ $n }}.0.10:9000'));
  for (const v of vaults) L.push(...svc(`vault-${v}`, `http://${vaultIp(v, '{{ $n }}')}:4321`));
  L.push(...svc('portal', 'http://{{ $n }}.0.94:3000'));
  L.push(...svc('metamcp', 'http://{{ $n }}.0.11:12008'));
  L.push(...svc('mcp-gate', 'http://{{ $n }}.0.12:8080'));
  return L.join('\n') + '\n';
}

// Authentik system blueprints this blueprint depends on (akadmin + "authentik Admins"; managed proxy scopes)
const BLUEPRINT_DEPS = [
  "  # Dependencies: akadmin + \"authentik Admins\" (bootstrap) and the managed proxy scope mappings must exist",
  "  # before this blueprint references them (fresh stack: otherwise providers get no property mappings)",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: authentik Bootstrap }, required: true }",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: \"System - OAuth2 Provider - Scopes\" }, required: true }",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: \"System - Proxy Provider - Scopes\" }, required: true }",
  "  # Default flows the admin MFA entries below extend or reference",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: \"Default - Authentication flow\" }, required: true }",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: \"Default - TOTP MFA setup flow\" }, required: true }",
  "  - model: authentik_blueprints.metaapplyblueprint",
  "    attrs: { identifiers: { name: \"Default - WebAuthn MFA setup flow\" }, required: true }",
];
// Explicit scope mappings: a provider created before the managed mappings exist would otherwise get none
// and the outpost would send an empty X-authentik-username (401 everywhere)
const PROXY_PROPERTY_MAPPINGS = [
  "      property_mappings:",
  "        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-openid]]",
  "        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-profile]]",
  "        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-email]]",
  "        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-entitlements]]",
  "        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/proxy/scope-proxy]]",
];

const PORTAL_PERMISSIONS = ['view_user', 'add_user', 'change_user', 'delete_user', 'reset_user_password', 'view_group',
  'add_user_to_group', 'remove_user_from_group', 'view_authenticatedsession', 'delete_authenticatedsession'];

// Mandatory MFA for operators (Oliver's decision): superusers, lokyy-admins and "authentik Admins" must pass
// TOTP or WebAuthn after the password; without a device the stage walks them through the setup. Employees
// (vault / lokyy-users groups) are not affected. The policy runs when the stage is reached (the user is
// known then). Recovery links cannot skip it for admins: the portal's set-password flow refuses superusers
// and lokyy-admins (apps/portal/authentik/lokyy-portal.yaml).
const ADMIN_MFA = [
  '  - model: authentik_stages_authenticator_validate.authenticatorvalidatestage',
  '    id: stage-admin-mfa',
  '    identifiers: { name: lokyy-admin-mfa }',
  '    attrs:',
  '      name: lokyy-admin-mfa',
  '      device_classes: [totp, webauthn]',
  '      not_configured_action: configure',
  '      configuration_stages:',
  '        - !Find [authentik_stages_authenticator_totp.authenticatortotpstage, [name, default-authenticator-totp-setup]]',
  '        - !Find [authentik_stages_authenticator_webauthn.authenticatorwebauthnstage, [name, default-authenticator-webauthn-setup]]',
  // A device validated moments ago by the default MFA stage (order 30) counts: no second prompt
  '      last_auth_threshold: minutes=5',
  '  - model: authentik_policies_expression.expressionpolicy',
  '    id: policy-admin-mfa',
  '    identifiers: { name: lokyy-admin-mfa-required }',
  '    attrs:',
  '      name: lokyy-admin-mfa-required',
  '      expression: |',
  '        user = request.context.get("pending_user") or request.user',
  '        if user.is_superuser:',
  '            return True',
  '        return user.groups.filter(name__in=["lokyy-admins", "authentik Admins"]).exists()',
  '  - model: authentik_flows.flowstagebinding',
  '    id: binding-admin-mfa',
  '    identifiers: { target: !Find [authentik_flows.flow, [slug, default-authentication-flow]], stage: !KeyOf stage-admin-mfa, order: 35 }',
  '    attrs:',
  '      evaluate_on_plan: false',
  '      re_evaluate_policies: true',
  '      invalid_response_action: retry',
  '  - model: authentik_policies.policybinding',
  '    identifiers: { target: !KeyOf binding-admin-mfa, policy: !KeyOf policy-admin-mfa }',
  '    attrs: { target: !KeyOf binding-admin-mfa, policy: !KeyOf policy-admin-mfa, order: 0 }',
];

// Authentik blueprint: groups, one forward-auth proxy provider + application + group binding per vault,
// the embedded outpost, and the bootstrap admin (akadmin) in lokyy-admins. No other users: the portal
// creates them and assigns slots.
export function renderBlueprint(pkg: PackageName): string {
  const slots = slotNames(pkg);
  const L: string[] = [
    '# yaml-language-server: $schema=https://goauthentik.io/blueprints/schema.json',
    HEADER(pkg, 'Authentik blueprint (baked into the authentik image as custom/lokyy-slots.yaml).').trimEnd(),
    'version: 1',
    'metadata:',
    '  name: lokyy-slots',
    '  labels:',
    '    blueprints.goauthentik.io/instantiate: "true"',
    'entries:',
    ...BLUEPRINT_DEPS,
    '  # Web access to a personal vault slot (exactly one user per group)',
  ];
  const group = (key: string, name: string) =>
    `  - { model: authentik_core.group, id: group-${key}, identifiers: { name: ${name} }, attrs: { name: ${name} } }`;
  for (const v of slots) L.push(group(v, `vault-${v}`));
  L.push(group('firma-write', 'vault-firma-write'), group('firma-read', 'vault-firma-read'), group('admins', 'lokyy-admins'));
  L.push('  # Every employee the portal invites (portal access, "Mein Zugang")', group('users', 'lokyy-users'));
  // MED-3: the portal's least-privilege service account (LBV2-28): exactly the calls of
  // apps/portal/src/server/authentik.ts; no superuser, no RBAC, flow, provider or token permissions. Its
  // token key comes from a Coolify magic variable; only authentik-gate receives it.
  L.push(
    '  - model: authentik_rbac.role',
    '    id: role-portal',
    '    identifiers: { name: lokyy-portal }',
    '    attrs:',
    '      name: lokyy-portal',
    '      permissions:',
    ...PORTAL_PERMISSIONS.map((p) => `        - authentik_core.${p}`),
    '  - model: authentik_core.user',
    '    id: sa-portal',
    '    identifiers: { username: lokyy-portal }',
    '    attrs:',
    '      username: lokyy-portal',
    '      name: Lokyy Brain Portal (service account)',
    '      type: service_account',
    '      path: lokyy-system',
    '      roles: [!KeyOf role-portal]',
    '  - model: authentik_core.token',
    '    identifiers: { identifier: lokyy-portal-api }',
    '    attrs:',
    '      identifier: lokyy-portal-api',
    '      intent: api',
    '      user: !KeyOf sa-portal',
    '      expiring: false',
    '      key: !Env PORTAL_AUTHENTIK_TOKEN',
  );
  L.push(
    '  - model: authentik_core.user',
    '    identifiers: { username: akadmin }',
    '    state: present',
    '    attrs:',
    '      groups: [!Find [authentik_core.group, [name, "authentik Admins"]], !KeyOf group-admins]',
  );
  const app = (key: string, name: string, title: string, host: string, groupKey: string | string[], first = false) => {
    L.push(
      '  - model: authentik_providers_proxy.proxyprovider',
      `    id: provider-${key}`,
      `    identifiers: { name: ${name} }`,
      ...(first
        ? [
          '    attrs: &provider',
          `      name: ${name}`,
          '      mode: forward_single',
          `      external_host: !Format ["https://${host}.%s", !Env BASE_DOMAIN]`,
          '      authorization_flow: !Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]',
          '      invalidation_flow: !Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]',
          '      access_token_validity: hours=8',
          ...PROXY_PROPERTY_MAPPINGS,
        ]
        : ['    attrs:', '      <<: *provider', `      name: ${name}`, `      external_host: !Format ["https://${host}.%s", !Env BASE_DOMAIN]`]),
      '  - model: authentik_core.application',
      `    id: app-${key}`,
      `    identifiers: { slug: ${name} }`,
      `    attrs: { name: ${title}, slug: ${name}, provider: !KeyOf provider-${key}, policy_engine_mode: any }`,
      ...[groupKey].flat().flatMap((g, order) => [
        '  - model: authentik_policies.policybinding',
        `    identifiers: { target: !KeyOf app-${key}, group: !KeyOf group-${g} }`,
        `    attrs: { target: !KeyOf app-${key}, group: !KeyOf group-${g}, order: ${order} }`,
      ]),
    );
  };
  slots.forEach((v, i) => app(v, `vault-${v}`, `"Lokyy Brain · Vault ${v}"`, v, v, i === 0));
  L.push('  # Company vault web UI: only writers (readers use MCP with the read-only token)');
  app('firma', 'vault-firma', '"Lokyy Brain · Firmen-Vault"', 'firma', 'firma-write');
  L.push('  # Setup portal: every invited employee and the operators (admin functions are checked inside the portal)');
  app('portal', 'lokyy-portal', '"Lokyy Brain · Portal"', 'app', ['users', 'admins']);
  L.push('  # MetaMCP admin UI: operators only');
  app('metamcp', 'metamcp-admin', '"Lokyy Brain · MetaMCP Admin"', 'mcp', 'admins');
  L.push('  # Mandatory MFA for operators', ...ADMIN_MFA);
  // Brand (LBV2-35): what users see on the login pages. Only these fields; the portal's blueprint sets the
  // recovery flow and locale of the same brand.
  L.push(
    '  - model: authentik_brands.brand',
    '    identifiers: { domain: authentik-default }',
    '    state: present',
    '    attrs:',
    '      branding_title: Lokyy Brain',
    '  - model: authentik_flows.flow',
    '    identifiers: { slug: default-authentication-flow }',
    '    state: present',
    '    attrs:',
    '      title: Lokyy Brain',
  );
  L.push(
    '  - model: authentik_outposts.outpost',
    '    identifiers: { managed: goauthentik.io/outposts/embedded }',
    '    state: present',
    '    attrs:',
    '      providers:',
    ...[...slots, 'firma', 'portal', 'metamcp'].map((k) => `        - !KeyOf provider-${k}`),
    '      config:',
    '        authentik_host: !Format ["https://auth.%s", !Env BASE_DOMAIN]',
    '        authentik_host_browser: !Format ["https://auth.%s", !Env BASE_DOMAIN]',
  );
  return L.join('\n') + '\n';
}

export function outputs(): { path: string; content: string }[] {
  return (Object.keys(PACKAGES) as PackageName[]).flatMap((pkg) => [
    { path: `compose-${pkg}.yml`, content: renderCompose(pkg) },
    { path: `traefik/dynamic-${pkg}.yml`, content: renderTraefikDynamic(pkg) },
    { path: `authentik/blueprints/lokyy-${pkg}.yaml`, content: renderBlueprint(pkg) },
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { path, content } of outputs()) {
    const file = join(dir, path);
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* new file */ }
    if (current === content) continue;
    if (check) { console.error(`stale: deploy/coolify/${path}`); stale++; } else { writeFileSync(file, content); console.log(`wrote deploy/coolify/${path}`); }
  }
  process.exit(stale ? 1 : 0);
}
