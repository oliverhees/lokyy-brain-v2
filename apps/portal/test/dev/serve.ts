// Local UI preview against in-memory fakes (no Authentik/MetaMCP needed):
//   node test/dev/serve.ts            → http://127.0.0.1:18390  (build the client first: pnpm build)
// Plays Traefik: adds the proxy secret and an identity. ?as=<user> switches the identity (cookie);
// "akadmin" is admin, every other name an employee. The fake watcher "provisions" every 2 s; the fake
// EUrouter knows the key sk-eu-abcdefghijkl1234 (two routes). Never use outside local development.
import express from 'express';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import { AuditLog } from '../../src/server/audit.ts';
import { harness } from '../fakes/harness.ts';

const h = harness();
const PROXY = 'dev-proxy-secret-0123456789abcdefghij';
const CSRF = 'dev-csrf';
const portal = createApp({
  service: h.service, audit: new AuditLog(join(h.dir, 'audit.log')), proxySecret: PROXY, csrfSecret: CSRF,
  publicOrigin: 'http://127.0.0.1:18390', staticDir: new URL('../../dist/client', import.meta.url).pathname, log: console.log,
});

if (process.env['DEV_SEED'] !== '0') {
  await h.service.setCompany('akadmin', { name: 'Muster GmbH' });
  await h.service.invite('akadmin', { username: 'anna', email: 'anna@example.com', displayName: 'Anna Muster', role: 'reader' });
  await h.service.invite('akadmin', { username: 'ben', email: 'ben@example.com', displayName: 'Ben Beispiel', role: 'writer' });
  await h.service.markActive('ben');
}
setInterval(() => h.watcher.run(), 2000);

const app = express();
app.use((req, res, next) => {
  const m = /(?:^|;\s*)dev_as=([a-z0-9-]+)/.exec(req.headers.cookie ?? '');
  const q = typeof req.query['as'] === 'string' ? req.query['as'] : null;
  const who = q ?? m?.[1] ?? 'akadmin';
  if (q) res.cookie('dev_as', q, { sameSite: 'strict' });
  req.headers['x-vault-proxy-secret'] = PROXY;
  req.headers['x-authentik-username'] = who;
  req.headers['x-authentik-groups'] = who === 'akadmin' ? 'authentik Admins|lokyy-admins' : 'vault-v01';
  next();
});
app.use(portal);
app.listen(18390, '127.0.0.1', () => console.log('preview on http://127.0.0.1:18390 (?as=anna for an employee)'));
