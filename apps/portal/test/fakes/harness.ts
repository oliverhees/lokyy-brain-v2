// Wires a PortalService to in-memory Authentik/MetaMCP/vault/mail fakes and a temp state dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthentikClient } from '../../src/server/authentik.ts';
import { MetamcpProvisioner, READ_TOOLS } from '../../src/server/metamcp.ts';
import { PortalService, type Mailer, type VaultAdmin } from '../../src/server/service.ts';
import { StateStore } from '../../src/server/state.ts';
import { AuditLog } from '../../src/server/audit.ts';
import { FakeAuthentik } from './authentik.ts';
import { ALL_TOOLS, FakeMetamcp } from './metamcp.ts';

export const SLOTS = ['v01', 'v02', 'v03'];

export class FakeVaultAdmin implements VaultAdmin {
  calls: { vault: string; apiKey: string; model: string }[] = [];
  failFor = new Set<string>();
  async configureLlm(vault: string, llm: { apiKey: string; model: string }): Promise<void> {
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

export interface Harness {
  dir: string;
  ak: FakeAuthentik;
  mm: FakeMetamcp;
  vaults: FakeVaultAdmin;
  mailer: FakeMailer;
  store: StateStore;
  service: PortalService;
  cleanup(): void;
}

export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'portal-svc-'));
  const groups = [...SLOTS.map((s) => `vault-${s}`), 'vault-firma-read', 'vault-firma-write', 'lokyy-admins'];
  const ak = new FakeAuthentik(groups);
  const env: Record<string, string> = { MCP_TOKEN_FIRMA: 'tok-firma', MCP_READONLY_TOKEN_FIRMA: 'tok-firma-ro' };
  const tools: Record<string, string[]> = { 'tok-firma': ALL_TOOLS, 'tok-firma-ro': [...READ_TOOLS] };
  for (const s of SLOTS) { env[`MCP_TOKEN_${s.toUpperCase()}`] = `tok-${s}`; tools[`tok-${s}`] = ALL_TOOLS; }
  const mm = new FakeMetamcp(tools);
  const vaults = new FakeVaultAdmin();
  const mailer = new FakeMailer();
  const store = new StateStore(dir);
  const service = new PortalService({
    domain: 'example.com',
    slots: SLOTS,
    store,
    audit: new AuditLog(join(dir, 'audit.log')),
    authentik: new AuthentikClient({ baseUrl: 'http://authentik-server:9000', token: 'tok-secret', fetch: ak.fetch }),
    metamcp: new MetamcpProvisioner({ db: mm.db, baseUrl: 'http://metamcp:12008', publicBase: 'https://mcp.example.com', fetch: mm.fetch, env }),
    vaultAdmin: vaults,
    mailerFactory: (smtp) => (smtp ? mailer : null),
    inviteValidity: 'days=7',
    log: () => {},
  });
  return { dir, ak, mm, vaults, mailer, store, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
