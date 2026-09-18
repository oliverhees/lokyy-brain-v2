// Portal entry point: node src/server/main.ts (Node 24 type stripping, no build step for the server).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { AuditLog } from './audit.ts';
import { AuthentikClient } from './authentik.ts';
import { loadConfig } from './config.ts';
import { EurouterClient } from './eurouter.ts';
import { createMailer } from './mailer.ts';
import { FileProvisioning } from './provisioning.ts';
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
await store.update(() => {}); // (re)write users.json so the watcher always has an input file
const audit = new AuditLog(join(config.stateDir, 'audit.log'));

const service = new PortalService({
  domain: config.domain,
  siteUrl: config.siteUrl,
  mcpPublicBase: config.mcpPublicBase,
  slots: config.slots,
  store,
  audit,
  authentik: new AuthentikClient({ baseUrl: config.authentik.url, publicUrl: config.authentik.publicUrl, token: config.authentik.token }),
  provisioning: new FileProvisioning(config.provisionDir),
  eurouter: new EurouterClient(),
  vaultAdmin: new HttpVaultAdmin(config.vaultAdminUrl),
  mailerFactory: createMailer,
  inviteValidity: config.inviteValidity,
  log,
});

const app = createApp({
  service, audit, proxySecret: config.proxySecret, csrfSecret, publicOrigin: config.publicOrigin,
  packageName: config.package, staticDir: config.staticDir, log,
});
const server = app.listen(config.port, '0.0.0.0', () => log(`portal listening on :${config.port} for ${config.domain} (${config.slots.length} slots)`));
server.requestTimeout = 120_000;
server.headersTimeout = 20_000;

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
