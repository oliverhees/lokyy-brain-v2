// Portal use cases: setup wizard, employee lifecycle (invite → active → disabled/removed) and the
// employee's own access. Orchestrates state store, Authentik, MetaMCP provisioning, vault LLM config
// and mail. The HTTP layer (app.ts) only authenticates, authorises and maps errors.
import {
  EUROUTER_BASE_URL, validateCompanyName, validateEurouterKey, validateInvite, validateModel, validateRole, validateSmtp,
  type FieldErrors, type Role,
} from '../shared/validation.ts';
import { inviteMail } from '../shared/i18n/mail.de.ts';
import { AuthentikClient, AuthentikError, managedGroupsFor } from './authentik.ts';
import type { MetamcpProvisioner, ProvisionResult } from './metamcp.ts';
import { COMPANY_VAULT, nextFreeSlot, toUsersJson } from './slots.ts';
import type { PortalState, SlotUser, SmtpSettings, StateStore } from './state.ts';
import type { AuditLog } from './audit.ts';

export { EUROUTER_BASE_URL };

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: FieldErrors;
  constructor(status: number, code: string, fields?: FieldErrors) {
    super(code);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

export interface VaultAdmin {
  /** Points the vault's LLM at EUrouter with this key and model (vault admin config API). */
  configureLlm(vault: string, llm: { apiKey: string; model: string }): Promise<void>;
}

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpWithPassword {
  settings: SmtpSettings;
  password: string | undefined;
}

export interface ServiceDeps {
  domain: string;
  slots: string[];
  store: StateStore;
  audit: AuditLog;
  authentik: AuthentikClient;
  metamcp: MetamcpProvisioner;
  vaultAdmin: VaultAdmin;
  mailerFactory: (smtp: SmtpWithPassword | null) => Mailer | null;
  /** Authentik duration of invitation links, e.g. "days=7" */
  inviteValidity: string;
  log: (msg: string) => void;
}

export interface InviteResult {
  user: SlotUser;
  inviteLink: string;
  mailed: boolean;
  mailError?: boolean;
}

const notFound = () => new ServiceError(404, 'user_not_found');
const now = () => new Date().toISOString();
const hint = (key: string) => `••••${key.slice(-4)}`;

export class PortalService {
  readonly #d: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.#d = deps;
  }

  get vaults(): string[] {
    return [COMPANY_VAULT, ...this.#d.slots];
  }

  // ---------------------------------------------------------------- setup wizard
  async setupStatus() {
    const s = await this.#d.store.read();
    const secrets = await this.#d.store.readSecrets();
    const taken = new Set([...s.users.map((u) => u.slot), ...s.retired.map((r) => r.slot)]);
    return {
      company: s.company,
      llm: s.llm ? { mode: s.llm.mode, model: s.llm.model, keyHints: s.llm.keyHints, baseUrl: EUROUTER_BASE_URL } : null,
      smtp: s.smtp ? { ...s.smtp, passwordSet: Boolean(secrets.smtpPassword) } : null,
      setupCompletedAt: s.setupCompletedAt,
      vaults: this.vaults,
      slots: { total: this.#d.slots.length, free: this.#d.slots.filter((x) => !taken.has(x)).length },
      lastProvisioning: s.lastProvisioning,
    };
  }

  async setCompany(actor: string, input: { name: unknown }): Promise<void> {
    const err = validateCompanyName(input.name);
    if (err) throw new ServiceError(400, 'invalid_input', { name: err });
    const name = (input.name as string).trim();
    await this.#d.store.update((s) => { s.company = { name }; });
    await this.#d.audit.write({ actor, action: 'setup.company', details: { name } });
  }

  async setLlm(actor: string, input: { mode: unknown; model: unknown; sharedKey?: unknown; keys?: unknown }): Promise<{ failed: string[] }> {
    const fields: FieldErrors = {};
    const modelErr = validateModel(input.model);
    if (modelErr) fields['model'] = modelErr;
    const plan = new Map<string, string>();
    if (input.mode === 'shared') {
      const e = validateEurouterKey(input.sharedKey);
      if (e) fields['sharedKey'] = e;
      else for (const v of this.vaults) plan.set(v, input.sharedKey as string);
    } else if (input.mode === 'per-vault') {
      const keys = input.keys;
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) fields['keys'] = 'required';
      else {
        for (const [vault, key] of Object.entries(keys as Record<string, unknown>)) {
          if (!this.vaults.includes(vault)) { fields[`keys.${vault}`] = 'unknown_vault'; continue; }
          if (key === '' || key === undefined || key === null) continue; // left empty: keep that vault as it is
          const e = validateEurouterKey(key);
          if (e) fields[`keys.${vault}`] = e; else plan.set(vault, key as string);
        }
        if (plan.size === 0 && Object.keys(fields).length === 0) fields['keys'] = 'required';
      }
    } else {
      fields['mode'] = 'invalid';
    }
    if (Object.keys(fields).length > 0) throw new ServiceError(400, 'invalid_input', fields);

    const model = input.model as string;
    const failed: string[] = [];
    const applied: Record<string, string> = {};
    for (const [vault, key] of plan) {
      try {
        await this.#d.vaultAdmin.configureLlm(vault, { apiKey: key, model });
        applied[vault] = hint(key);
      } catch (e) {
        this.#d.log(`LLM config for vault ${vault} failed: ${(e as Error).message}`);
        failed.push(vault);
      }
    }
    await this.#d.store.update((s) => {
      s.llm = { mode: input.mode as 'shared' | 'per-vault', model, keyHints: { ...(s.llm?.keyHints ?? {}), ...applied }, updatedAt: now() };
    });
    await this.#d.audit.write({ actor, action: 'setup.llm', details: { mode: String(input.mode), model, vaults: Object.keys(applied), failed } });
    return { failed };
  }

  async setSmtp(actor: string, input: { host: unknown; port: unknown; secure: unknown; username?: unknown; password?: unknown; from: unknown }): Promise<void> {
    const errors = validateSmtp({ ...input, username: input.username ?? '', password: input.password });
    const current = await this.#d.store.readSecrets();
    if (input.password === undefined && !current.smtpPassword && input.username) errors['password'] = 'required';
    if (Object.keys(errors).length > 0) throw new ServiceError(400, 'invalid_input', errors);
    if (typeof input.password === 'string' && input.password.length > 0) {
      await this.#d.store.updateSecrets((sec) => { sec.smtpPassword = input.password as string; });
    }
    await this.#d.store.update((s) => {
      s.smtp = { host: input.host as string, port: input.port as number, secure: input.secure as boolean,
        username: (input.username as string | undefined) ?? '', from: input.from as string, updatedAt: now() };
    });
    await this.#d.audit.write({ actor, action: 'setup.smtp', details: { host: input.host as string, port: input.port as number } });
  }

  async removeSmtp(actor: string): Promise<void> {
    await this.#d.store.updateSecrets((sec) => { delete sec.smtpPassword; });
    await this.#d.store.update((s) => { s.smtp = null; });
    await this.#d.audit.write({ actor, action: 'setup.smtp.remove' });
  }

  async testSmtp(actor: string, to: unknown): Promise<void> {
    const mailer = await this.#mailer();
    if (!mailer) throw new ServiceError(409, 'smtp_not_configured');
    const err = validateInvite({ username: 'ab', email: to, displayName: 'x', role: 'reader' })['email'];
    if (err) throw new ServiceError(400, 'invalid_input', { to: err });
    try {
      await mailer.send({ to: to as string, subject: 'Lokyy Brain: Test-E-Mail', text: 'Der E-Mail-Versand von Lokyy Brain funktioniert.' });
    } catch (e) {
      this.#d.log(`SMTP test failed: ${(e as Error).message}`);
      throw new ServiceError(502, 'smtp_failed');
    }
    await this.#d.audit.write({ actor, action: 'setup.smtp.test' });
  }

  async completeSetup(actor: string): Promise<void> {
    await this.#d.store.update((s) => {
      if (!s.company || !s.llm) throw new ServiceError(409, 'setup_incomplete');
      s.setupCompletedAt ??= now();
    });
    await this.#d.audit.write({ actor, action: 'setup.complete' });
  }

  // ---------------------------------------------------------------- employees
  async listUsers() {
    const s = await this.#d.store.read();
    const taken = new Set([...s.users.map((u) => u.slot), ...s.retired.map((r) => r.slot)]);
    return {
      users: [...s.users].sort((a, b) => a.slot.localeCompare(b.slot)),
      retired: s.retired,
      freeSlots: this.#d.slots.filter((x) => !taken.has(x)).length,
      lastProvisioning: s.lastProvisioning,
    };
  }

  async invite(actor: string, input: { username: unknown; email: unknown; displayName: unknown; role: unknown }): Promise<InviteResult> {
    const fields = validateInvite(input);
    if (Object.keys(fields).length > 0) throw new ServiceError(400, 'invalid_input', fields);
    const username = input.username as string;
    const email = (input.email as string).trim();
    const displayName = (input.displayName as string).trim();
    const role = input.role as Role;

    // Reserve a slot. A former user coming back gets their old slot (and data) again.
    const reserved = await this.#d.store.update((s) => {
      if (s.users.some((u) => u.username === username)) throw new ServiceError(409, 'username_exists');
      if (s.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new ServiceError(409, 'email_exists');
      const former = s.retired.find((r) => r.formerUsername === username && this.#d.slots.includes(r.slot));
      const slot = former?.slot ?? nextFreeSlot(this.#d.slots, s);
      if (!slot) throw new ServiceError(409, 'no_free_slot');
      if (former) s.retired = s.retired.filter((r) => r !== former);
      const user: SlotUser = { slot, username, email, displayName, role, status: 'invited', authentikPk: null,
        provisioning: 'pending', invitedAt: now(), activatedAt: null, updatedAt: now() };
      s.users.push(user);
      return { user, former: former ?? null };
    });

    let pk: number;
    try {
      pk = await this.#d.authentik.ensureUser({ username, name: displayName, email, slot: reserved.user.slot, groups: managedGroupsFor(reserved.user.slot, role) });
    } catch (e) {
      await this.#d.store.update((s) => {
        s.users = s.users.filter((u) => u.username !== username);
        if (reserved.former) s.retired.push(reserved.former);
      });
      throw this.#mapAuthentik(e);
    }
    await this.#patch(username, (u) => { u.authentikPk = pk; });
    const link = await this.#inviteLink(pk);
    await this.#provision();
    const mail = await this.#mailInvite(username, link);
    await this.#d.audit.write({ actor, action: 'user.invite', target: username, details: { slot: reserved.user.slot, role, mailed: mail.mailed } });
    return { user: await this.#get(username), inviteLink: link, ...mail };
  }

  async resendInvite(actor: string, username: string): Promise<{ inviteLink: string; mailed: boolean; mailError?: boolean }> {
    const u = await this.#get(username);
    if (u.status !== 'invited') throw new ServiceError(409, 'not_invited');
    const pk = await this.#ensureAuthentik(u);
    const link = await this.#inviteLink(pk);
    const mail = await this.#mailInvite(username, link);
    await this.#d.audit.write({ actor, action: 'user.invite.resend', target: username, details: { mailed: mail.mailed } });
    return { inviteLink: link, ...mail };
  }

  async changeRole(actor: string, username: string, role: unknown): Promise<SlotUser> {
    const err = validateRole(role);
    if (err) throw new ServiceError(400, 'invalid_input', { role: err });
    const u = await this.#get(username);
    const from = u.role;
    await this.#patch(username, (x) => { x.role = role as Role; });
    try {
      if (u.status !== 'disabled') await this.#d.authentik.setGroups(await this.#ensureAuthentik({ ...u, role: role as Role }), managedGroupsFor(u.slot, role as Role));
    } catch (e) {
      await this.#patch(username, (x) => { x.role = from; });
      throw this.#mapAuthentik(e);
    }
    await this.#provision();
    await this.#d.audit.write({ actor, action: 'user.role', target: username, details: { from, to: role as string } });
    return this.#get(username);
  }

  async disable(actor: string, username: string): Promise<void> {
    const u = await this.#get(username);
    if (u.authentikPk !== null) {
      try {
        await this.#d.authentik.setActive(u.authentikPk, false);
        await this.#d.authentik.endSessions(username);
      } catch (e) { throw this.#mapAuthentik(e); }
    }
    await this.#patch(username, (x) => { x.status = 'disabled'; });
    await this.#provision(); // not in users.json any more → MetaMCP account and key removed
    await this.#d.audit.write({ actor, action: 'user.disable', target: username });
  }

  async enable(actor: string, username: string): Promise<void> {
    const u = await this.#get(username);
    if (u.status !== 'disabled') throw new ServiceError(409, 'not_disabled');
    try {
      const pk = await this.#ensureAuthentik(u);
      await this.#d.authentik.setActive(pk, true);
    } catch (e) { throw this.#mapAuthentik(e); }
    await this.#patch(username, (x) => { x.status = x.activatedAt ? 'active' : 'invited'; });
    await this.#provision();
    await this.#d.audit.write({ actor, action: 'user.enable', target: username });
  }

  async remove(actor: string, username: string, opts: { confirm: unknown; keepData: unknown }): Promise<void> {
    const u = await this.#get(username);
    if (opts.confirm !== username) throw new ServiceError(400, 'confirm_mismatch');
    // Wiping needs a vault-side API that does not exist yet; never pretend to have deleted data.
    if (opts.keepData !== true) throw new ServiceError(400, 'wipe_unsupported');
    try {
      if (u.authentikPk !== null) {
        await this.#d.authentik.endSessions(username);
        await this.#d.authentik.deleteUser(u.authentikPk);
      }
    } catch (e) { throw this.#mapAuthentik(e); }
    await this.#d.store.update((s) => {
      s.users = s.users.filter((x) => x.username !== username);
      s.retired.push({ slot: u.slot, formerUsername: username, retiredAt: now() });
    });
    await this.#provision();
    await this.#d.audit.write({ actor, action: 'user.remove', target: username, details: { slot: u.slot, keepData: true } });
  }

  /** Re-runs MetaMCP provisioning for everyone (after a failure). */
  async reprovision(actor: string): Promise<ProvisionResult> {
    const r = await this.#provision();
    await this.#d.audit.write({ actor, action: 'provision.retry', details: { status: r.status } });
    return r;
  }

  // ---------------------------------------------------------------- self service
  async markActive(username: string): Promise<void> {
    await this.#d.store.update((s) => {
      const u = s.users.find((x) => x.username === username);
      if (u && u.status === 'invited') { u.status = 'active'; u.activatedAt = now(); u.updatedAt = now(); }
    });
  }

  async myAccess(username: string) {
    const u = await this.#self(username);
    if (u.status === 'invited') await this.markActive(username);
    const s = await this.#d.store.read();
    return {
      username: u.username,
      displayName: u.displayName,
      slot: u.slot,
      role: u.role,
      companyName: s.company?.name ?? null,
      vaultUrl: `https://${u.slot}.${this.#d.domain}`,
      // Readers use the company vault through MCP only (read-only token); its web UI is for writers.
      companyVaultUrl: u.role === 'writer' ? `https://${COMPANY_VAULT}.${this.#d.domain}` : null,
      mcpUrl: `https://mcp.${this.#d.domain}/metamcp/${u.username}/mcp`,
      serverName: 'lokyy',
      provisioning: u.provisioning,
    };
  }

  async revealKey(username: string): Promise<string> {
    await this.#self(username);
    const key = await this.#d.metamcp.readKey(username);
    if (!key) throw new ServiceError(409, 'key_not_provisioned');
    await this.#d.audit.write({ actor: username, action: 'key.reveal', target: username });
    return key;
  }

  async rotateKey(username: string): Promise<string> {
    await this.#self(username);
    const r = await this.#provision([username]);
    if (r.status !== 'ok') throw new ServiceError(502, 'provisioning_failed');
    await this.#d.audit.write({ actor: username, action: 'key.rotate', target: username });
    const key = await this.#d.metamcp.readKey(username);
    if (!key) throw new ServiceError(409, 'key_not_provisioned');
    return key;
  }

  // ---------------------------------------------------------------- internals
  async #get(username: string): Promise<SlotUser> {
    const u = (await this.#d.store.read()).users.find((x) => x.username === username);
    if (!u) throw notFound();
    return u;
  }

  async #self(username: string): Promise<SlotUser> {
    const u = (await this.#d.store.read()).users.find((x) => x.username === username);
    if (!u) throw new ServiceError(404, 'no_access');
    if (u.status === 'disabled') throw new ServiceError(403, 'disabled');
    return u;
  }

  async #patch(username: string, fn: (u: SlotUser) => void): Promise<void> {
    await this.#d.store.update((s) => {
      const u = s.users.find((x) => x.username === username);
      if (!u) throw notFound();
      fn(u);
      u.updatedAt = now();
    });
  }

  /** Authentik user of a state record; re-creates it when missing (e.g. deleted by hand). */
  async #ensureAuthentik(u: SlotUser): Promise<number> {
    const pk = await this.#d.authentik.ensureUser({ username: u.username, name: u.displayName, email: u.email, slot: u.slot, groups: managedGroupsFor(u.slot, u.role) })
      .catch((e: unknown) => { throw this.#mapAuthentik(e); });
    if (pk !== u.authentikPk) await this.#patch(u.username, (x) => { x.authentikPk = pk; });
    return pk;
  }

  async #inviteLink(pk: number): Promise<string> {
    try {
      return await this.#d.authentik.inviteLink(pk, this.#d.inviteValidity);
    } catch (e) { throw this.#mapAuthentik(e); }
  }

  async #provision(rotate: string[] = []): Promise<ProvisionResult> {
    const state = await this.#d.store.read();
    const result = await this.#d.metamcp.reconcile(toUsersJson(state), { rotate });
    const listed = new Set(toUsersJson(state).users.map((u) => u.username));
    await this.#d.store.update((s: PortalState) => {
      for (const u of s.users) if (listed.has(u.username)) u.provisioning = result.status === 'ok' ? 'ok' : 'failed';
      s.lastProvisioning = { at: now(), status: result.status, restartMetamcp: result.restartMetamcp, ...(result.error ? { error: result.error } : {}) };
    });
    if (result.status !== 'ok') this.#d.log(`MetaMCP provisioning failed: ${result.error}`);
    return result;
  }

  async #mailer(): Promise<Mailer | null> {
    const s = await this.#d.store.read();
    if (!s.smtp) return this.#d.mailerFactory(null);
    return this.#d.mailerFactory({ settings: s.smtp, password: (await this.#d.store.readSecrets()).smtpPassword });
  }

  async #mailInvite(username: string, link: string): Promise<{ mailed: boolean; mailError?: boolean }> {
    const mailer = await this.#mailer();
    if (!mailer) return { mailed: false };
    const u = await this.#get(username);
    const s = await this.#d.store.read();
    const days = Number(/days=(\d+)/.exec(this.#d.inviteValidity)?.[1] ?? 7);
    try {
      await mailer.send({ to: u.email, ...inviteMail({ companyName: s.company?.name ?? null, displayName: u.displayName, link, validDays: days }) });
      return { mailed: true };
    } catch (e) {
      this.#d.log(`invitation mail to ${username} failed: ${(e as Error).message}`);
      return { mailed: false, mailError: true };
    }
  }

  #mapAuthentik(e: unknown): Error {
    if (e instanceof ServiceError) return e;
    if (e instanceof AuthentikError) {
      this.#d.log(e.message);
      if (e.code === 'username_taken') return new ServiceError(409, 'username_taken');
      if (e.code === 'group_missing') return new ServiceError(500, 'authentik_group_missing');
      if (e.code === 'no_recovery_flow') return new ServiceError(500, 'authentik_no_recovery_flow');
      return new ServiceError(502, 'authentik_failed');
    }
    return e as Error;
  }
}
