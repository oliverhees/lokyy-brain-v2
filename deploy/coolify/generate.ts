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
export interface GenerateOptions { embed?: boolean }

export interface Service {
  image?: string;
  build?: { context: string; dockerfile?: string; args?: Record<string, string> };
  command?: string[];
  entrypoint?: string[];
  restart?: string;
  mem_limit?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  shm_size?: string;
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
  ipam?: { config: { subnet: string }[] };
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
const CONNECTOR_IP = `${NET}.0.50`;
const EMBED_PORT = 8090;

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
  authentikApiToken: magic.hex('authentikapitoken'),
  adminPassword: magic.password('admin'),
  metamcpDb: magic.hex('metamcpdb'),
  metamcpAuth: magic.hex('metamcpauth'),
  metamcpAdmin: magic.password('metamcpadmin'),
  embedToken: magic.hex('embedtoken'),
};

/** /28 per network; slot k (1-based, firma = 0) gets <prefix>.<2+k>.0/28 (web) and .16/28 (mcp). */
function subnet(name: string): string {
  const fixed: Record<string, string> = {
    edge: '0.0/28', 'authentik-internal': '0.16/28', 'metamcp-internal': '0.32/28', 'mcp-upstream': '0.48/28',
    'model-egress': '0.64/28', portal: '0.80/28', egress: '1.0/26', 'embed-internal': '0.96/28',
  };
  if (fixed[name]) return `${NET}.${fixed[name]}`;
  const m = /^(web|mcp)-(v(\d+)|firma)$/.exec(name);
  if (!m) throw new Error(`no subnet for ${name}`);
  const k = m[2] === 'firma' ? 0 : Number(m[3]);
  return `${NET}.${2 + k}.${m[1] === 'web' ? 0 : 16}/28`;
}
const network = (name: string, extra: Network = {}): Network => ({ ...extra, ipam: { config: [{ subnet: subnet(name) }] } });

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
  if (opts.embed) {
    env.MINDBASE_EMBED_URL = `http://embed:${EMBED_PORT}/embed`;
    env.MINDBASE_EMBED_TOKEN = secret.embedToken;
  }
  return {
    build: { context: REPO, dockerfile: 'deploy/Dockerfile' },
    restart: 'unless-stopped',
    // LBV2-20: idle ~200 MiB, peak 2.62 GiB with bge-m3 loaded
    mem_limit: '${VAULT_MEM_LIMIT:-3500m}',
    depends_on: { 'model-prefetch': { condition: 'service_completed_successfully' } },
    environment: env,
    volumes: [`vault-${v}:/data`, 'models:/models:ro', `vault-${v}-home:/home/vault`],
    networks: { [`web-${v}`]: {}, [`mcp-${v}`]: { aliases: [`upstream.vault-${v}`] }, egress: {} },
  };
}

export function buildCompose(pkg: PackageName, opts: GenerateOptions = {}): Compose {
  const vaults = vaultNames(pkg);
  const hosts = ['auth', 'mcp', 'app', ...vaults];
  const services: Record<string, Service> = {};

  // coolify-proxy labels: one TLS router (own HTTP-01 certificate) per public host, one HTTP->HTTPS
  // redirect router for all of them. Only this container carries traefik.* labels.
  const labels = ['traefik.enable=true', 'traefik.docker.network=coolify'];
  for (const h of hosts) {
    const r = `lokyy-${h}`;
    labels.push(
      `traefik.http.routers.${r}.rule=Host(\`${h}.\${BASE_DOMAIN}\`)`,
      `traefik.http.routers.${r}.entrypoints=https`,
      `traefik.http.routers.${r}.tls=true`,
      `traefik.http.routers.${r}.tls.certresolver=letsencrypt`,
      `traefik.http.routers.${r}.service=lokyy-inner`,
    );
  }
  labels.push(
    `traefik.http.routers.lokyy-http.rule=${hosts.map((h) => `Host(\`${h}.\${BASE_DOMAIN}\`)`).join(' || ')}`,
    'traefik.http.routers.lokyy-http.entrypoints=http',
    'traefik.http.routers.lokyy-http.middlewares=lokyy-to-https',
    'traefik.http.routers.lokyy-http.service=lokyy-inner',
    'traefik.http.middlewares.lokyy-to-https.redirectscheme.scheme=https',
    'traefik.http.middlewares.lokyy-to-https.redirectscheme.permanent=true',
    'traefik.http.services.lokyy-inner.loadbalancer.server.port=80',
  );
  const traefikEnv: Record<string, string> = { BASE_DOMAIN: DOMAIN, PROXY_SECRET_PORTAL: secret.portalProxy };
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
      // X-Forwarded-For from coolify-proxy (rate-limit bucket per client, Authentik audit IP). Host and
      // Proto are pinned per router in dynamic.yml, so a co-located container can only forge the client IP.
      '--entrypoints.web.forwardedHeaders.trustedIPs=${LOKYY_TRUSTED_PROXY_CIDRS:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}',
      // X_authentik_username / X.Authentik.Username must not alias a managed header in WSGI-style backends
      '--entrypoints.web.http.aliasheadersstrategy=delete',
      '--api.dashboard=false',
      '--log.level=INFO',
    ],
    environment: traefikEnv,
    labels,
    networks: ['coolify', 'edge', 'portal', ...vaults.map((v) => `web-${v}`)],
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
    // the blueprint puts akadmin into lokyy-admins. The bootstrap token is the portal's API token.
    AUTHENTIK_BOOTSTRAP_EMAIL: EMAIL,
    AUTHENTIK_BOOTSTRAP_PASSWORD: secret.adminPassword,
    AUTHENTIK_BOOTSTRAP_TOKEN: secret.authentikApiToken,
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
  services['authentik-server'] = authentik('server', ['edge', 'authentik-internal']);
  services['authentik-worker'] = authentik('worker', ['authentik-internal']);

  // -------------------------------------------------------------------- Portal
  // Setup portal (LBV2-28, apps/portal). Writes users.json into lokyy-state (the only writer).
  services.portal = {
    build: { context: REPO, dockerfile: 'apps/portal/Dockerfile' },
    restart: 'unless-stopped',
    mem_limit: '512m',
    environment: {
      PORT: '3000',
      BASE_DOMAIN: DOMAIN,
      ADMIN_EMAIL: EMAIL,
      LOKYY_PACKAGE: pkg,
      LOKYY_SLOTS: slotNames(pkg).join(','),
      LOKYY_STATE_DIR: '/state',
      AUTHENTIK_URL: 'http://authentik-server:9000',
      AUTHENTIK_API_TOKEN: secret.authentikApiToken,
      VAULT_PROXY_SECRET: secret.portalProxy,
    },
    volumes: ['lokyy-state:/state'],
    networks: ['portal', 'edge'],
  };

  // -------------------------------------------------------------------- Vaults
  // One-shot: fills the shared model cache (pinned revision, SHA-256 per file); vaults mount it read-only.
  services['model-prefetch'] = {
    build: { context: REPO, dockerfile: 'deploy/Dockerfile' },
    restart: 'no',
    entrypoint: ['node', '/lokyy/models/prefetch.mjs'],
    volumes: ['models:/models'],
    networks: ['model-egress'],
  };
  for (const v of vaults) services[`vault-${v}`] = vault(v, opts);

  if (opts.embed) {
    // LBV2-26: shared embedding service. Not yet part of the default package.
    services.embed = {
      build: { context: REPO, dockerfile: 'deploy/Dockerfile' },
      restart: 'unless-stopped',
      mem_limit: '3500m',
      depends_on: { 'model-prefetch': { condition: 'service_completed_successfully' } },
      environment: { EMBED_PORT: String(EMBED_PORT), EMBED_TOKEN: secret.embedToken, MINDBASE_MODELS_OFFLINE: '1', NODE_OPTIONS: '--import=/lokyy/models/offline.mjs' },
      volumes: ['models:/models:ro'],
      networks: ['embed-internal'],
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
  // Vault tokens for provisioning (metamcp/provision.mjs reads MCP_TOKEN_<VAULT>); MetaMCP stores them anyway.
  for (const v of vaults) metamcpEnv[`MCP_TOKEN_${v.toUpperCase()}`] = secret.mcpToken(v);
  metamcpEnv.MCP_READONLY_TOKEN_FIRMA = secret.mcpReadonlyFirma;
  services.metamcp = {
    image: 'ghcr.io/metatool-ai/metamcp:2.4.22',
    restart: 'unless-stopped',
    mem_limit: '1536m',
    depends_on: { 'metamcp-db': { condition: 'service_healthy' } },
    environment: metamcpEnv,
    // No egress, no vault network: vaults are reached only through vault-connector
    networks: ['edge', 'metamcp-internal', 'mcp-upstream'],
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
    environment: { MODE: 'gate', GATE_UPSTREAM: 'http://metamcp:12008', GATE_USERS_FILE: '/etc/lokyy/users.json' },
    volumes: ['lokyy-state:/etc/lokyy:ro'],
    depends_on: { metamcp: { condition: 'service_healthy' } },
    networks: ['edge'],
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
    edge: network('edge'),
    'authentik-internal': network('authentik-internal', { internal: true }),
    'metamcp-internal': network('metamcp-internal', { internal: true }),
    'mcp-upstream': network('mcp-upstream', { internal: true }),
    portal: network('portal', { internal: true }),
    'model-egress': network('model-egress'),
    egress: network('egress', { driver: 'bridge', driver_opts: { 'com.docker.network.bridge.enable_icc': 'false' } }),
  };
  if (opts.embed) networks['embed-internal'] = network('embed-internal', { internal: true });
  for (const v of vaults) {
    networks[`web-${v}`] = network(`web-${v}`, { internal: true });
    networks[`mcp-${v}`] = network(`mcp-${v}`, { internal: true });
  }

  const volumes: Record<string, Record<string, never>> = { 'authentik-db': {}, 'metamcp-db': {}, models: {}, 'lokyy-state': {} };
  for (const v of vaults) { volumes[`vault-${v}`] = {}; volumes[`vault-${v}-home`] = {}; }
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
  L.push('{{ $d := env `BASE_DOMAIN` }}');
  L.push('http:', '  routers:');
  L.push('    authentik:', '      rule: "Host(`auth.{{ $d }}`)"', '      entryPoints: ["web"]', '      service: "authentik"');
  for (const v of vaults) {
    const r = guarded(`vault-${v}`, v, `vault-${v}`, ['"vault-identity"', `"vault-${v}-secret"`]);
    L.push(...r);
  }
  L.push(...guarded('portal', 'app', 'portal', ['"vault-identity"', '"portal-secret"']));
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
    '        address: "http://authentik-server:9000/outpost.goauthentik.io/auth/traefik"',
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
  L.push(...svc('authentik', 'http://authentik-server:9000'));
  for (const v of vaults) L.push(...svc(`vault-${v}`, `http://vault-${v}:4321`));
  L.push(...svc('portal', 'http://portal:3000'));
  L.push(...svc('metamcp', 'http://metamcp:12008'));
  L.push(...svc('mcp-gate', 'http://mcp-gate:8080'));
  return L.join('\n') + '\n';
}

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
    '  # Web access to a personal vault slot (exactly one user per group)',
  ];
  const group = (key: string, name: string) =>
    `  - { model: authentik_core.group, id: group-${key}, identifiers: { name: ${name} }, attrs: { name: ${name} } }`;
  for (const v of slots) L.push(group(v, `vault-${v}`));
  L.push(group('firma-write', 'vault-firma-write'), group('firma-read', 'vault-firma-read'), group('admins', 'lokyy-admins'));
  L.push(
    '  - model: authentik_core.user',
    '    identifiers: { username: akadmin }',
    '    state: present',
    '    attrs:',
    '      groups: [!KeyOf group-admins]',
  );
  const app = (key: string, name: string, title: string, host: string, groupKey: string, first = false) => {
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
        ]
        : ['    attrs:', '      <<: *provider', `      name: ${name}`, `      external_host: !Format ["https://${host}.%s", !Env BASE_DOMAIN]`]),
      '  - model: authentik_core.application',
      `    id: app-${key}`,
      `    identifiers: { slug: ${name} }`,
      `    attrs: { name: ${title}, slug: ${name}, provider: !KeyOf provider-${key}, policy_engine_mode: any }`,
      '  - model: authentik_policies.policybinding',
      `    identifiers: { target: !KeyOf app-${key}, group: !KeyOf group-${groupKey} }`,
      `    attrs: { target: !KeyOf app-${key}, group: !KeyOf group-${groupKey}, order: 0 }`,
    );
  };
  slots.forEach((v, i) => app(v, `vault-${v}`, `"Vault ${v}"`, v, v, i === 0));
  L.push('  # Company vault web UI: only writers (readers use MCP with the read-only token)');
  app('firma', 'vault-firma', 'Firmen-Vault', 'firma', 'firma-write');
  L.push('  # Setup portal and MetaMCP admin UI: operators only');
  app('portal', 'lokyy-portal', 'Lokyy Setup', 'app', 'admins');
  app('metamcp', 'metamcp-admin', 'MetaMCP Admin', 'mcp', 'admins');
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
