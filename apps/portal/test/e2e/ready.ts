// Readiness probe for run.sh: the stack is usable only when forward-auth delivers a non-empty identity
// to the portal (QA HIGH 1: providers without property mappings sent an empty X-authentik-username).
import { Browser } from '../integration/browser.ts';

const port = process.env['E2E_PUBLIC_PORT'] ?? '18380';
const deadline = Date.now() + 300_000;
for (;;) {
  try {
    const r = await new Browser().visit(`http://app.portal.localhost:${port}/api/session`, { username: 'akadmin', password: process.env['AUTHENTIK_ADMIN_PASS']! });
    const body = r.status === 200 ? (JSON.parse(r.body) as { username?: string }) : {};
    if (body.username === 'akadmin') { console.log('ready: portal sees the Authentik identity'); process.exit(0); }
    console.log(`not ready: HTTP ${r.status}`);
  } catch (e) {
    console.log(`not ready: ${(e as Error).message.slice(0, 120)}`);
  }
  if (Date.now() > deadline) { console.error('portal identity not ready after 300 s'); process.exit(1); }
  await new Promise((res) => setTimeout(res, 5000));
}
