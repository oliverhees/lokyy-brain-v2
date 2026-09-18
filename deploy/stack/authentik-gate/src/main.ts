// authentik-gate entry point. Configuration only via environment:
//   AUTHENTIK_URL        http://authentik-server:9000
//   AUTHENTIK_API_TOKEN  token of the lokyy-portal service account (only this service holds it)
//   GATE_SECRET          shared bearer secret of the portal (>= 32 chars)
//   PORT                 8080;  GATE_RATE_PER_MINUTE  120
import { createGate } from './gate.ts';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) { console.error(`fatal: ${name} is required`); process.exit(1); }
  return v;
};
const secret = env('GATE_SECRET');
if (secret.length < 32 || secret.trim() !== secret) { console.error('fatal: GATE_SECRET must be at least 32 characters'); process.exit(1); }

const server = createGate({
  authentikUrl: env('AUTHENTIK_URL', 'http://authentik-server:9000'),
  authentikToken: env('AUTHENTIK_API_TOKEN'),
  secret,
  log,
  ratePerMinute: Number.parseInt(process.env['GATE_RATE_PER_MINUTE'] ?? '', 10) || 120,
});
const port = Number.parseInt(process.env['PORT'] ?? '', 10) || 8080;
server.listen(port, '0.0.0.0', () => log(`authentik-gate listening on :${port}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
