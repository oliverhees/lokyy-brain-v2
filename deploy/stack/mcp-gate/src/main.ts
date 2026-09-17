// Entry point. MODE=gate (session-binding proxy for MetaMCP endpoints) or MODE=connector
// (one-way MetaMCP → vault forwarder). Configuration only via environment; no secrets needed.
import { createGate } from './gate.ts';
import { createConnector } from './connector.ts';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') { console.error(`fatal: ${name} is required`); process.exit(1); }
  return v;
};
const int = (name: string, fallback: number): number => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const mode = env('MODE', 'gate');
if (mode === 'gate') {
  const server = createGate({
    upstream: env('GATE_UPSTREAM', 'http://metamcp:12008'),
    idleMs: int('GATE_IDLE_MS', 60 * 60 * 1000),               // 1 h unused
    lifetimeMs: int('GATE_LIFETIME_MS', 8 * 60 * 60 * 1000),   // 8 h, same as MetaMCP SESSION_LIFETIME
    maxBindings: int('GATE_MAX_BINDINGS', 10_000),
    maxBodyBytes: int('GATE_MAX_BODY_BYTES', 4 * 1024 * 1024),
    log,
  });
  const port = int('PORT', 8080);
  server.listen(port, '0.0.0.0', () => log(`mcp-gate listening on :${port}`));
} else if (mode === 'connector') {
  const vaults = env('CONNECTOR_VAULTS').split(',').map((v) => v.trim()).filter(Boolean);
  const listenHost = env('CONNECTOR_LISTEN_HOST'); // the mcp-upstream address only
  const server = createConnector({ vaults, target: (v) => ({ host: `upstream.vault-${v}`, port: 4322 }), log });
  server.listen(4322, listenHost, () => log(`vault-connector listening on ${listenHost}:4322 for ${vaults.join(',')}`));
} else {
  console.error(`fatal: unknown MODE ${mode}`);
  process.exit(1);
}
