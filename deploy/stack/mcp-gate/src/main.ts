// Entry point. MODE=gate (session-binding proxy for MetaMCP endpoints) or MODE=connector
// (one-way MetaMCP → vault forwarder). Configuration only via environment; no secrets needed.
import { readFileSync } from 'node:fs';
import { createGate, globalBindingCap } from './gate.ts';
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
const maxPerKey = int('GATE_MAX_SESSIONS_PER_KEY', 20);
// Global cap: GATE_MAX_BINDINGS if set, else derived from the provisioned users (GATE_USERS_FILE, one
// API key per user): users × per-key cap × 1.25, at least 100.
function bindingCap(): number {
  const explicit = int('GATE_MAX_BINDINGS', 0);
  if (explicit > 0) return explicit;
  try {
    const users = JSON.parse(readFileSync(process.env.GATE_USERS_FILE ?? '/etc/lokyy/users.json', 'utf8')).users;
    return globalBindingCap(Array.isArray(users) ? users.length : 0, maxPerKey);
  } catch {
    return globalBindingCap(0, maxPerKey);
  }
}
if (mode === 'gate') {
  const server = createGate({
    upstream: env('GATE_UPSTREAM', 'http://metamcp:12008'),
    idleMs: int('GATE_IDLE_MS', 60 * 60 * 1000),               // 1 h unused
    lifetimeMs: int('GATE_LIFETIME_MS', 8 * 60 * 60 * 1000),   // 8 h, same as MetaMCP SESSION_LIFETIME
    maxBindings: bindingCap(),                                   // global; full → new keys refused (503)
    maxPerKey,                                                    // a key over it loses its own oldest session
    initRatePerSec: int('GATE_INIT_RATE_PER_SEC', 1),
    initBurst: int('GATE_INIT_BURST', 5),
    maxStreamsPerSession: int('GATE_MAX_STREAMS_PER_SESSION', 2),
    maxStreamsPerKey: int('GATE_MAX_STREAMS_PER_KEY', 10),
    maxBodyBytes: int('GATE_MAX_BODY_BYTES', 1024 * 1024),
    maxConnections: int('GATE_MAX_CONNECTIONS', 512),
    requestTimeoutMs: int('GATE_REQUEST_TIMEOUT_MS', 30_000),         // request incl. body (slowloris); SSE responses exempt
    sseIdleMs: int('GATE_STREAM_IDLE_MS', 15 * 60 * 1000),
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
