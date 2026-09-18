// Portal use cases: setup wizard, employee lifecycle (invite → active → disabled/removed) and the
// employee's own access. Orchestrates state store, Authentik, MetaMCP provisioning, vault LLM config
// and mail. The HTTP layer (app.ts) only authenticates, authorises and maps errors.
import {
  EUROUTER_BASE_URL, validateCompanyName, validateEurouterKey, validateInvite, validateRole, validateRuleId, validateSmtp,
  type FieldErrors, type Role,
} from '../shared/validation.ts';
import { inviteMail } from '../shared/i18n/mail.de.ts';
import { AuthentikClient, AuthentikError, managedGroupsFor } from './authentik.ts';
import type { MetamcpProvisioner, ProvisionResult } from './metamcp.ts';
import { COMPANY_VAULT, nextFreeSlot, toUsersJson } from './slots.ts';
import type { PortalState, SlotUser, SmtpSettings, StateStore, VaultLlm } from './state.ts';
import { EurouterError, type RoutingRule } from './eurouter.ts';
import type { HostCheck } from './smtp-guard.ts';
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

export interface VaultLlmConfig {
  apiKey: string;
  /** EUrouter route; the vault sends it as rule_id, without a model (vault config field ruleId, LBV2-30) */
  ruleId: string;
}

export interface VaultAdmin {
  /** Points the vault's LLM at EUrouter with this key and route (vault admin config API). */
  configureLlm(vault: string, llm: VaultLlmConfig): Promise<void>;
}

export interface Routes {
  listRules(apiKey: string): Promise<RoutingRule[]>;
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
  /** Public URL of a host under the domain (default https://<host>.<domain>) */
  siteUrl?: (host: string) => string;
  /** Public MCP base (default https://mcp.<domain>) */
  mcpPublicBase?: string;
  slots: string[];
  store: StateStore;
  audit: AuditLog;
  authentik: AuthentikClient;
  metamcp: MetamcpProvisioner;
  eurouter: Routes;
  /** Refuses SMTP hosts that resolve to private addresses (unless allow-listed) */
  smtpHostCheck: (host: string) => Promise<HostCheck>;
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
      llm: s.llm ? { mode: s.llm.mode, vaults: s.llm.vaults ?? {}, baseUrl: EUROUTER_BASE_URL } : null,
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

  /** Routes (routing rules) of an EUrouter key; also the live check of the key. */
  async listRoutes(actor: string, input: { apiKey: unknown }): Promise<RoutingRule[]> {
    const e = validateEurouterKey(input.apiKey);
    if (e) throw new ServiceError(400, 'invalid_input', { apiKey: e });
    const rules = await this.#rules((input.apiKey as string).trim(), 'apiKey');
    await this.#d.audit.write({ actor, action: 'setup.llm.routes', details: { count: rules.length } });
    return rules;
  }

  /** EUrouter key + route for all vaults (shared) or per vault; the route brings its models. */
  async setLlm(actor: string, input: { mode?: unknown; apiKey?: unknown; ruleId?: unknown; vaults?: unknown }): Promise<{ failed: string[] }> {
    const fields: FieldErrors = {};
    const wanted: { vault: string; apiKey: string; ruleId: string; prefix: string }[] = [];
    if (input.mode === 'shared') {
      const k = validateEurouterKey(input.apiKey);
      const r = validateRuleId(input.ruleId);
      if (k) fields['apiKey'] = k;
      if (r) fields['ruleId'] = r;
      if (!k && !r) for (const v of this.vaults) wanted.push({ vault: v, apiKey: (input.apiKey as string).trim(), ruleId: input.ruleId as string, prefix: '' });
    } else if (input.mode === 'per-vault') {
      const vs = input.vaults;
      if (!vs || typeof vs !== 'object' || Array.isArray(vs) || Object.keys(vs).length === 0) fields['vaults'] = 'required';
      else {
        for (const [vault, cfg] of Object.entries(vs as Record<string, { apiKey?: unknown; ruleId?: unknown } | null>)) {
          if (!this.vaults.includes(vault)) { fields[`vaults.${vault}`] = 'unknown_vault'; continue; }
          const k = validateEurouterKey(cfg?.apiKey);
          const r = validateRuleId(cfg?.ruleId);
          if (k) fields[`vaults.${vault}.apiKey`] = k;
          if (r) fields[`vaults.${vault}.ruleId`] = r;
          if (!k && !r) wanted.push({ vault, apiKey: (cfg!.apiKey as string).trim(), ruleId: cfg!.ruleId as string, prefix: `vaults.${vault}.` });
        }
      }
    } else {
      fields['mode'] = 'invalid';
    }
    if (Object.keys(fields).length > 0) throw new ServiceError(400, 'invalid_input', fields);

    // Live check: every key must be accepted by EUrouter and the route must belong to that key.
    const rulesByKey = new Map<string, RoutingRule[]>();
    const names = new Map<string, string>();
    for (const w of wanted) {
      if (!rulesByKey.has(w.apiKey)) rulesByKey.set(w.apiKey, await this.#rules(w.apiKey, `${w.prefix}apiKey`));
      const rule = rulesByKey.get(w.apiKey)!.find((r) => r.id === w.ruleId);
      if (!rule) throw new ServiceError(400, 'invalid_input', { [`${w.prefix}ruleId`]: 'unknown_route' });
      names.set(w.vault, rule.name);
    }

    const failed: string[] = [];
    const applied: Record<string, VaultLlm> = {};
    for (const w of wanted) {
      let ok = true;
      try {
        await this.#d.vaultAdmin.configureLlm(w.vault, { apiKey: w.apiKey, ruleId: w.ruleId });
        applied[w.vault] = { keyHint: hint(w.apiKey), ruleId: w.ruleId, ruleName: names.get(w.vault)! };
      } catch (e) {
        ok = false;
        this.#d.log(`LLM config for vault ${w.vault} failed: ${(e as Error).message}`);
        failed.push(w.vault);
      }
      await this.#d.audit.write({ actor, action: 'vault.config', target: w.vault, details: { ok, ruleId: w.ruleId } });
    }
    await this.#d.store.update((st) => {
      st.llm = { mode: input.mode as 'shared' | 'per-vault', vaults: { ...(st.llm?.vaults ?? {}), ...applied }, updatedAt: now() };
    });
    await this.#d.audit.write({ actor, action: 'setup.llm', details: { mode: String(input.mode), vaults: Object.keys(applied), failed } });
    return { failed };
  }

  async setSmtp(actor: string, input: { host: unknown; port: unknown; secure: unknown; username?: unknown; password?: unknown; from: unknown }): Promise<void> {
    const errors = validateSmtp({ ...input, username: input.username ?? '', password: input.password });
    const current = await this.#d.store.readSecrets();
    if (input.password === undefined && !current.smtpPassword && input.username) errors['password'] = 'required';
    if (!errors['host']) {
      const check = await this.#d.smtpHostCheck(input.host as string);
      if (!check.ok) errors['host'] = check.reason === 'private' ? 'private_host' : 'unresolvable';
    }
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

  async invite(actor: string, input: { username: unknown; email: unknown; displayName: unknown; role: unknown; restoreSlot?: unknown }): Promise<InviteResult> {
    const fields = validateInvite(input);
    if (Object.keys(fields).length > 0) throw new ServiceError(400, 'invalid_input', fields);
    const username = input.username as string;
    const email = (input.email as string).trim();
    const displayName = (input.displayName as string).trim();
    const role = input.role as Role;

    // Reserve a slot. The retired slot (and data) of a former user with this name is only restored on the
    // admin's explicit request: the same username may belong to a different person now (audit M1).
    const restore = input.restoreSlot === true;
    const reserved = await this.#d.store.update((s) => {
      if (s.users.some((u) => u.username === username)) throw new ServiceError(409, 'username_exists');
      if (s.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new ServiceError(409, 'email_exists');
      const former = restore ? s.retired.find((r) => r.formerUsername === username && this.#d.slots.includes(r.slot)) : undefined;
      if (restore && !former) throw new ServiceError(409, 'no_retired_slot');
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
    await this.#d.audit.write({ actor, action: 'user.invite', target: username, details: { slot: reserved.user.slot, role, mailed: mail.mailed, restoredSlot: reserved.former !== null } });
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
    // Old key first and independently of MetaMCP HTTP: open sessions must not keep the old access (audit H1).
    const revoked = await this.#revoke(username);
    await this.#patch(username, (x) => { x.role = role as Role; });
    try {
      if (u.status !== 'disabled') await this.#d.authentik.setGroups(await this.#ensureAuthentik({ ...u, role: role as Role }), managedGroupsFor(u.slot, role as Role));
    } catch (e) {
      await this.#patch(username, (x) => { x.role = from; });
      throw this.#mapAuthentik(e);
    }
    await this.#provision();
    await this.#d.audit.write({ actor, action: 'user.role', target: username, details: { from, to: role as string, revoked } });
    if (!revoked) throw new ServiceError(502, 'revocation_failed');
    return this.#get(username);
  }

  async disable(actor: string, username: string): Promise<void> {
    const u = await this.#get(username);
    // Revoke first, independently of Authentik and MetaMCP HTTP; everything else still runs if it fails.
    const revoked = await this.#revoke(username);
    await this.#patch(username, (x) => { x.status = 'disabled'; });
    let authentikError: Error | null = null;
    if (u.authentikPk !== null) {
      try {
        await this.#d.authentik.setActive(u.authentikPk, false);
        await this.#d.authentik.endSessions(username);
      } catch (e) { authentikError = this.#mapAuthentik(e); }
    }
    await this.#provision(); // not provisioned any more → MetaMCP account removed
    await this.#d.audit.write({ actor, action: 'user.disable', target: username, details: { revoked, authentik: authentikError === null } });
    if (!revoked) throw new ServiceError(502, 'revocation_failed');
    if (authentikError) throw authentikError;
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
    // Wiping needs a vault-side API (separate item); never pretend to have deleted data.
    if (opts.keepData !== true) throw new ServiceError(400, 'wipe_unsupported');
    const revoked = await this.#revoke(username);
    if (!revoked) {
      // Keep the user (disabled) so the removal can be retried; access must be gone before the record is.
      await this.#patch(username, (x) => { x.status = 'disabled'; });
      await this.#d.audit.write({ actor, action: 'user.remove', target: username, details: { slot: u.slot, revoked: false } });
      throw new ServiceError(502, 'revocation_failed');
    }
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
    await this.#d.audit.write({ actor, action: 'user.remove', target: username, details: { slot: u.slot, keepData: true, revoked: true } });
  }

  /** Explicitly frees a retired slot: the next invitation gets it, including the former user's vault data. */
  async releaseSlot(actor: string, slot: string, opts: { confirm: unknown }): Promise<void> {
    if (opts.confirm !== slot) throw new ServiceError(400, 'confirm_mismatch');
    const former = await this.#d.store.update((s) => {
      const r = s.retired.find((x) => x.slot === slot);
      if (!r) throw new ServiceError(404, 'slot_not_retired');
      s.retired = s.retired.filter((x) => x !== r);
      return r.formerUsername;
    });
    await this.#d.audit.write({ actor, action: 'slot.release', target: slot, details: { formerUsername: former } });
  }

  /** Re-runs MetaMCP provisioning for everyone (after a failure). */
  async reprovision(actor: string): Promise<ProvisionResult> {
    const r = await this.#provision();
    await this.#d.audit.write({ actor, action: 'provision.retry', details: { status: r.status } });
    return r;
  }

  // ---------------------------------------------------------------- self service
  /** First use after setting the password (explicit POST from the UI; GET /api/me has no side effects). */
  async activate(username: string): Promise<void> {
    await this.#self(username);
    await this.#d.store.update((s) => {
      const u = s.users.find((x) => x.username === username);
      if (u && u.status === 'invited') { u.status = 'active'; u.activatedAt = now(); u.updatedAt = now(); }
    });
  }

  async myAccess(username: string) {
    const u = await this.#self(username);
    const s = await this.#d.store.read();
    return {
      username: u.username,
      displayName: u.displayName,
      slot: u.slot,
      role: u.role,
      companyName: s.company?.name ?? null,
      vaultUrl: this.#site(u.slot),
      // Readers use the company vault through MCP only (read-only token); its web UI is for writers.
      companyVaultUrl: u.role === 'writer' ? this.#site(COMPANY_VAULT) : null,
      mcpUrl: `${this.#d.mcpPublicBase ?? `https://mcp.${this.#d.domain}`}/metamcp/${u.username}/mcp`,
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
  #site(host: string): string {
    return this.#d.siteUrl ? this.#d.siteUrl(host) : `https://${host}.${this.#d.domain}`;
  }

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

  /** Revokes the user's MetaMCP keys directly in MetaMCP's database; false (and logged) on failure. */
  async #revoke(username: string): Promise<boolean> {
    try {
      await this.#d.metamcp.revoke(username);
      return true;
    } catch (e) {
      this.#d.log(`revoking MetaMCP keys of ${username} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async #rules(apiKey: string, field: string): Promise<RoutingRule[]> {
    try {
      return await this.#d.eurouter.listRules(apiKey);
    } catch (e) {
      if (e instanceof EurouterError && e.code === 'invalid_key') throw new ServiceError(400, 'invalid_input', { [field]: 'invalid_key' });
      this.#d.log(`EUrouter: ${(e as Error).message}`);
      throw new ServiceError(502, 'eurouter_unavailable');
    }
  }

  async #provision(rotate: string[] = []): Promise<ProvisionResult> {
    // The state is read inside the provisioning queue: a run waiting behind another one never uses a
    // stale snapshot (e.g. a rotation that was queued before a disable).
    let spec = toUsersJson(await this.#d.store.read()); // replaced by the in-queue read
    const result = await this.#d.metamcp.reconcile(async () => (spec = toUsersJson(await this.#d.store.read())), { rotate });
    const listed = new Set(spec.users.map((u) => u.username));
    const failedUsers = new Set(result.failedUsers);
    await this.#d.store.update((s: PortalState) => {
      for (const u of s.users) if (listed.has(u.username)) u.provisioning = failedUsers.has(u.username) ? 'failed' : 'ok';
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
