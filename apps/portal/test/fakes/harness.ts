// Wires a PortalService to in-memory Authentik / EUrouter / vault / mail fakes, a temp state dir and a
// stand-in provisioning watcher (call h.watcher.run() where the real watcher would react).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthentikClient } from '../../src/server/authentik.ts';
import { FileProvisioning } from '../../src/server/provisioning.ts';
import { PortalService, type Mailer, type VaultAdmin, type VaultLlmConfig } from '../../src/server/service.ts';
import { StateStore } from '../../src/server/state.ts';
import { AuditLog } from '../../src/server/audit.ts';
import { EurouterError, type RoutingRule } from '../../src/server/eurouter.ts';
import { FakeAuthentik } from './authentik.ts';
import { FakeWatcher } from './watcher.ts';

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

/** key → routing rules of that EUrouter account; unknown keys are rejected like EUrouter does (401). */
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

export interface Harness {
  dir: string;
  ak: FakeAuthentik;
  watcher: FakeWatcher;
  eurouter: FakeEurouter;
  vaults: FakeVaultAdmin;
  mailer: FakeMailer;
  store: StateStore;
  service: PortalService;
  cleanup(): void;
}

export function harness(opts: { siteUrl?: (host: string) => string; mcpPublicBase?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'portal-svc-'));
  const stateDir = join(dir, 'state');
  const provisionDir = join(dir, 'provision');
  const groups = [...SLOTS.map((s) => `vault-${s}`), 'vault-firma-read', 'vault-firma-write', 'lokyy-admins', 'lokyy-users'];
  const ak = new FakeAuthentik(groups);
  const watcher = new FakeWatcher(stateDir, provisionDir);
  const eurouter = new FakeEurouter();
  eurouter.accounts.set('sk-eu-abcdefghijkl1234', [RULE_A, RULE_B]);
  eurouter.accounts.set('sk-eu-other-00000009', [RULE_B]);
  const vaults = new FakeVaultAdmin();
  const mailer = new FakeMailer();
  const store = new StateStore(stateDir);
  const service = new PortalService({
    domain: 'example.com',
    slots: SLOTS,
    store,
    audit: new AuditLog(join(dir, 'audit.log')),
    authentik: new AuthentikClient({ baseUrl: 'http://authentik-server:9000', token: 'tok-secret', fetch: ak.fetch }),
    provisioning: new FileProvisioning(provisionDir),
    eurouter,
    vaultAdmin: vaults,
    mailerFactory: (smtp) => (smtp ? mailer : null),
    inviteValidity: 'days=7',
    log: () => {},
    ...opts,
  });
  return { dir, ak, watcher, eurouter, vaults, mailer, store, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
