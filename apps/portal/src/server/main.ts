// Portal entry point: node src/server/main.ts (Node 24 type stripping, no build step for the server).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from './app.ts';
import { AuditLog } from './audit.ts';
import { AuthentikClient } from './authentik.ts';
import { loadConfig } from './config.ts';
import { createMailer } from './mailer.ts';
import { MetamcpProvisioner } from './metamcp.ts';
import { PortalService } from './service.ts';
import { StateStore } from './state.ts';
import { HttpVaultAdmin } from './vault-admin.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
}

const store = new StateStore(config.stateDir);
await store.read(); // refuse to start on a corrupt state file
const csrfSecret = await store.updateSecrets((s) => (s.csrfSecret ??= randomBytes(32).toString('hex')));
const audit = new AuditLog(join(config.stateDir, 'audit.log'));
const pool = new pg.Pool({ connectionString: config.metamcp.databaseUrl, max: 2, idleTimeoutMillis: 30_000 });
pool.on('error', (e) => log(`metamcp db: ${e.message}`));

const service = new PortalService({
  domain: config.domain,
  slots: config.slots,
  store,
  audit,
  authentik: new AuthentikClient({ baseUrl: config.authentik.url, token: config.authentik.token }),
  metamcp: new MetamcpProvisioner({
    db: pool, baseUrl: config.metamcp.url, publicBase: config.metamcp.publicBase, origin: config.metamcp.origin,
    env: config.env, log: (m) => log(`[provision] ${m}`),
  }),
  vaultAdmin: new HttpVaultAdmin(config.vaultAdminUrl),
  mailerFactory: createMailer,
  inviteValidity: config.inviteValidity,
  log,
});

const app = createApp({ service, audit, proxySecret: config.proxySecret, csrfSecret, publicOrigin: config.publicOrigin, staticDir: config.staticDir, log });
const server = app.listen(config.port, '0.0.0.0', () => log(`portal listening on :${config.port} for ${config.domain} (${config.slots.length} slots)`));
server.requestTimeout = 120_000;
server.headersTimeout = 20_000;

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    server.close(() => { void pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
