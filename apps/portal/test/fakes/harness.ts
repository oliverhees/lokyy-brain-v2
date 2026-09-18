// Wires a PortalService to in-memory Authentik / MetaMCP / EUrouter / vault / mail fakes and a temp state dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthentikGateClient } from '../../src/server/authentik.ts';
import { MetamcpProvisioner, READ_TOOLS } from '../../src/server/metamcp.ts';
import { PortalService, type Mailer, type VaultAdmin, type VaultLlmConfig } from '../../src/server/service.ts';
import { EurouterError, type RoutingRule } from '../../src/server/eurouter.ts';
import { checkSmtpHost } from '../../src/server/smtp-guard.ts';
import { StateStore } from '../../src/server/state.ts';
import { AuditLog } from '../../src/server/audit.ts';
import { FakeAuthentik } from './authentik.ts';
import { fakeGate, GATE_SECRET, GATE_URL, type FakeGate } from './gate.ts';
import { ALL_TOOLS, FakeMetamcp } from './metamcp.ts';

export const SLOTS = ['v01', 'v02', 'v03'];

export class FakeVaultAdmin implements VaultAdmin {
  calls: ({ vault: string } & VaultLlmConfig)[] = [];
  failFor = new Set<string>();
  async configureLlm(vault: string, llm: VaultLlmConfig): Promise<void> {
    if (this.failFor.has(vault)) throw new Error(`vault ${vault} unreachable`);
    this.calls.push({ vault, ...llm });
  }
}

export class FakeMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  fail = false;
  async send(msg: { to: string; subject: string; text: string }): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(msg);
  }
}

/** key → routes of that EUrouter account; unknown keys are rejected like EUrouter does (401). */
export class FakeEurouter {
  accounts = new Map<string, RoutingRule[]>();
  down = false;
  async listRules(apiKey: string): Promise<RoutingRule[]> {
    if (this.down) throw new EurouterError('unavailable', 'down');
    const r = this.accounts.get(apiKey);
    if (!r) throw new EurouterError('invalid_key', 'rejected');
    return r;
  }
}

export const RULE_A = { id: '0b0a5a2e-0000-4000-8000-00000000000a', name: 'eu-standard' };
export const RULE_B = { id: '0b0a5a2e-0000-4000-8000-00000000000b', name: 'eu-premium' };

const DNS: Record<string, string[]> = {
  'smtp.example.com': ['93.184.216.34'], 'smtp2.example.com': ['93.184.216.35'], 'metamcp-db': ['10.234.3.2'], 'relay.lan': ['192.168.1.10'],
};

export interface Harness {
  dir: string;
  ak: FakeAuthentik;
  gate: FakeGate;
  mm: FakeMetamcp;
  eurouter: FakeEurouter;
  vaults: FakeVaultAdmin;
  mailer: FakeMailer;
  store: StateStore;
  service: PortalService;
  cleanup(): void;
}

export function harness(opts: { siteUrl?: (host: string) => string; mcpPublicBase?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'portal-svc-'));
  const groups = [...SLOTS.map((s) => `vault-${s}`), 'vault-firma-read', 'vault-firma-write', 'lokyy-admins', 'lokyy-users'];
  const ak = new FakeAuthentik(groups);
  const gate = fakeGate(ak);
  const env: Record<string, string> = { MCP_TOKEN_FIRMA: 'tok-firma', MCP_READONLY_TOKEN_FIRMA: 'tok-firma-ro' };
  const tools: Record<string, string[]> = { 'tok-firma': ALL_TOOLS, 'tok-firma-ro': [...READ_TOOLS] };
  for (const s of SLOTS) { env[`MCP_TOKEN_${s.toUpperCase()}`] = `tok-${s}`; tools[`tok-${s}`] = ALL_TOOLS; }
  const mm = new FakeMetamcp(tools);
  const vaults = new FakeVaultAdmin();
  const eurouter = new FakeEurouter();
  eurouter.accounts.set('sk-eu-abcdefghijkl1234', [RULE_A, RULE_B]);
  eurouter.accounts.set('sk-eu-other-00000009', [RULE_B]);
  const mailer = new FakeMailer();
  const store = new StateStore(dir);
  const service = new PortalService({
    domain: 'example.com',
    slots: SLOTS,
    store,
    audit: new AuditLog(join(dir, 'audit.log')),
    authentik: new AuthentikGateClient({ gateUrl: GATE_URL, secret: GATE_SECRET, fetch: gate.fetch }),
    metamcp: new MetamcpProvisioner({ db: mm.db, baseUrl: 'http://metamcp:12008', publicBase: 'https://mcp.example.com', fetch: mm.fetch, env }),
    eurouter,
    smtpHostCheck: (host) => checkSmtpHost(host, ['relay.lan'], async (h) => {
      if (!DNS[h]) throw new Error('ENOTFOUND');
      return DNS[h]!;
    }),
    vaultAdmin: vaults,
    mailerFactory: (smtp) => (smtp ? mailer : null),
    inviteValidity: 'days=7',
    log: () => {},
    ...opts,
  });
  return { dir, ak, gate, mm, eurouter, vaults, mailer, store, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
