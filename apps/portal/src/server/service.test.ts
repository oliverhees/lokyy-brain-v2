import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, RULE_A, RULE_B, type Harness } from '../../test/fakes/harness.ts';
import { ServiceError } from './service.ts';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const KEY = 'sk-eu-abcdefghijkl1234';
const invite = (username: string, role: 'reader' | 'writer' = 'reader') =>
  h.service.invite('admin', { username, email: `${username}@example.com`, displayName: `${username} Name`, role });
const usersJson = () => JSON.parse(readFileSync(join(h.dir, 'state', 'users.json'), 'utf8'));
const stateFile = () => readFileSync(join(h.dir, 'state', 'state.json'), 'utf8');
const audit = () => readFileSync(join(h.dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const user = async (name: string) => (await h.service.listUsers()).users.find((u) => u.username === name)!;

describe('setup wizard', () => {
  it('stores the company name', async () => {
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    expect((await h.service.setupStatus()).company).toEqual({ name: 'Muster GmbH' });
  });

  it('rejects an invalid company name', async () => {
    await expect(h.service.setCompany('admin', { name: '' })).rejects.toMatchObject({ status: 400, fields: { name: 'required' } });
  });

  it('lists the EUrouter routing rules of a key (validates the key)', async () => {
    expect(await h.service.listRoutes('admin', { apiKey: KEY })).toEqual([RULE_A, RULE_B]);
    await expect(h.service.listRoutes('admin', { apiKey: 'sk-eu-wrong-0000000' })).rejects.toMatchObject({ status: 400, fields: { apiKey: 'invalid_key' } });
    await expect(h.service.listRoutes('admin', { apiKey: 'x' })).rejects.toMatchObject({ status: 400, fields: { apiKey: 'length' } });
    h.eurouter.down = true;
    await expect(h.service.listRoutes('admin', { apiKey: KEY })).rejects.toMatchObject({ status: 502, code: 'eurouter_unavailable' });
  });

  it('shared key + route go to every slot and the company vault; only hints, route id and name are kept', async () => {
    const r = await h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id });
    expect(r.failed).toEqual([]);
    expect(h.vaults.calls.map((c) => c.vault).sort()).toEqual(['firma', 'v01', 'v02', 'v03']);
    expect(h.vaults.calls[0]).toEqual({ vault: 'firma', apiKey: KEY, ruleId: RULE_A.id });
    const s = await h.service.setupStatus();
    expect(s.llm?.vaults['v01']).toEqual({ keyHint: '••••1234', ruleId: RULE_A.id, ruleName: 'eu-standard' });
    expect(stateFile()).not.toContain('abcdefghijkl');
    expect(JSON.stringify(audit())).not.toContain('abcdefghijkl');
  });

  it('every vault config call is audited', async () => {
    h.vaults.failFor.add('v02');
    await h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id });
    const calls = audit().filter((e) => e.action === 'vault.config');
    expect(calls.map((e) => [e.target, e.details.ok]).sort()).toEqual([['firma', true], ['v01', true], ['v02', false], ['v03', true]]);
  });

  it('refuses a route that does not belong to the key, before touching any vault', async () => {
    await expect(h.service.setLlm('admin', { mode: 'shared', apiKey: 'sk-eu-other-00000009', ruleId: RULE_A.id }))
      .rejects.toMatchObject({ status: 400, fields: { ruleId: 'unknown_route' } });
    await expect(h.service.setLlm('admin', { mode: 'shared', apiKey: 'sk-eu-wrong-0000000', ruleId: RULE_A.id }))
      .rejects.toMatchObject({ status: 400, fields: { apiKey: 'invalid_key' } });
    expect(h.vaults.calls).toEqual([]);
  });

  it('per vault: own key and route per vault; vaults left out stay unchanged', async () => {
    await h.service.setLlm('admin', { mode: 'per-vault', vaults: {
      firma: { apiKey: KEY, ruleId: RULE_B.id }, v02: { apiKey: 'sk-eu-other-00000009', ruleId: RULE_B.id } } });
    expect(h.vaults.calls.map((c) => [c.vault, c.apiKey, c.ruleId])).toEqual([['firma', KEY, RULE_B.id], ['v02', 'sk-eu-other-00000009', RULE_B.id]]);
    await expect(h.service.setLlm('admin', { mode: 'per-vault', vaults: { v99: { apiKey: KEY, ruleId: RULE_A.id } } }))
      .rejects.toMatchObject({ status: 400, fields: { 'vaults.v99': 'unknown_vault' } });
    await expect(h.service.setLlm('admin', { mode: 'per-vault', vaults: {} })).rejects.toMatchObject({ status: 400, fields: { vaults: 'required' } });
  });

  it('an optional model is passed through; there is no model default', async () => {
    await h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id, model: 'mistral/mistral-small-3.2' });
    expect(h.vaults.calls[0]).toMatchObject({ model: 'mistral/mistral-small-3.2' });
    await expect(h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id, model: 'bad model' })).rejects.toMatchObject({ status: 400 });
  });

  it('reports vaults that could not be configured and keeps the others', async () => {
    h.vaults.failFor.add('v02');
    const r = await h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id });
    expect(r.failed).toEqual(['v02']);
    expect(Object.keys((await h.service.setupStatus()).llm!.vaults).sort()).toEqual(['firma', 'v01', 'v03']);
  });

  it('SMTP: password stored as secret, never returned; update without password keeps it; removal deletes it', async () => {
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'mail-pass-123', from: 'noreply@example.com' });
    const s = await h.service.setupStatus();
    expect(s.smtp).toMatchObject({ host: 'smtp.example.com', passwordSet: true });
    expect(JSON.stringify(s)).not.toContain('mail-pass-123');
    expect(stateFile()).not.toContain('mail-pass-123');
    await h.service.setSmtp('admin', { host: 'smtp2.example.com', port: 465, secure: true, username: 'u', from: 'noreply@example.com' });
    expect((await h.store.readSecrets()).smtpPassword).toBe('mail-pass-123');
    await h.service.removeSmtp('admin');
    expect((await h.service.setupStatus()).smtp).toBeNull();
    expect((await h.store.readSecrets()).smtpPassword).toBeUndefined();
  });

  it('setup can only be completed once company and LLM are set', async () => {
    await expect(h.service.completeSetup('admin')).rejects.toMatchObject({ status: 409 });
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    await h.service.setLlm('admin', { mode: 'shared', apiKey: KEY, ruleId: RULE_A.id });
    await h.service.completeSetup('admin');
    expect((await h.service.setupStatus()).setupCompletedAt).not.toBeNull();
  });
});

describe('invite', () => {
  it('assigns the next free slot, creates the Authentik user with groups (incl. lokyy-users), writes users.json, returns a link', async () => {
    const r = await invite('anna', 'reader');
    expect(r.user).toMatchObject({ slot: 'v01', username: 'anna', status: 'invited', provisioning: 'pending' });
    expect(r.inviteLink).toContain('flow_token=');
    expect(h.ak.groupNamesOf(h.ak.userByName('anna')!.pk)).toEqual(['lokyy-users', 'vault-firma-read', 'vault-v01']);
    expect(usersJson()).toEqual({ companyVault: 'firma', generation: 1, users: [{ username: 'anna', role: 'reader', vault: 'v01', allowVaultNameMismatch: true }] });
    h.watcher.run();
    expect((await user('anna')).provisioning).toBe('ok');
    const second = await invite('ben', 'writer');
    expect(second.user.slot).toBe('v02');
    expect(h.ak.groupNamesOf(h.ak.userByName('ben')!.pk)).toEqual(['lokyy-users', 'vault-firma-write', 'vault-v02']);
  });

  it('mails the link when SMTP is configured; a mail failure does not fail the invitation', async () => {
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'pw', from: 'noreply@example.com' });
    const r = await invite('anna');
    expect(r.mailed).toBe(true);
    expect(h.mailer.sent[0]).toMatchObject({ to: 'anna@example.com' });
    expect(h.mailer.sent[0]!.text).toContain(r.inviteLink);
    expect(h.mailer.sent[0]!.subject).toContain('Muster GmbH');
    h.mailer.fail = true;
    const b = await invite('ben');
    expect(b).toMatchObject({ mailed: false, mailError: true });
  });

  it('rejects invalid input with field errors', async () => {
    await expect(h.service.invite('admin', { username: 'Anna', email: 'x', displayName: '', role: 'boss' }))
      .rejects.toMatchObject({ status: 400, fields: { username: 'charset', email: 'format', displayName: 'required', role: 'invalid' } });
  });

  it('rejects a duplicate username and a duplicate e-mail', async () => {
    await invite('anna');
    await expect(invite('anna')).rejects.toMatchObject({ status: 409, code: 'username_exists' });
    await expect(h.service.invite('admin', { username: 'anna2', email: 'ANNA@example.com', displayName: 'A', role: 'reader' }))
      .rejects.toMatchObject({ status: 409, code: 'email_exists' });
  });

  it('answers 409 no_free_slot when all slots are taken', async () => {
    await invite('anna'); await invite('ben'); await invite('carl');
    await expect(invite('dora')).rejects.toMatchObject({ status: 409, code: 'no_free_slot' });
  });

  it('frees the reserved slot when Authentik refuses the user (users.json unchanged)', async () => {
    h.ak.addUser({ username: 'anna', attributes: {} });
    await expect(invite('anna')).rejects.toMatchObject({ status: 409, code: 'username_taken' });
    expect((await h.service.listUsers()).users).toEqual([]);
    expect(usersJson().users).toEqual([]);
    expect((await invite('ben')).user.slot).toBe('v01');
  });

  it('parallel invitations never share a slot', async () => {
    const rs = await Promise.all(['anna', 'ben', 'carl'].map((u) => invite(u)));
    expect(rs.map((r) => r.user.slot).sort()).toEqual(['v01', 'v02', 'v03']);
  });

  it('resend creates a fresh link for invited users only', async () => {
    await invite('anna');
    expect((await h.service.resendInvite('admin', 'anna')).inviteLink).toContain('flow_token=');
    await h.service.markActive('anna');
    await expect(h.service.resendInvite('admin', 'anna')).rejects.toMatchObject({ status: 409 });
    await expect(h.service.resendInvite('admin', 'nobody')).rejects.toMatchObject({ status: 404 });
  });

  it('writes an audit entry without secrets or links', async () => {
    const r = await invite('anna');
    expect(audit().find((e) => e.action === 'user.invite')).toMatchObject({ actor: 'admin', target: 'anna', details: { slot: 'v01', role: 'reader' } });
    expect(JSON.stringify(audit())).not.toContain(r.inviteLink);
  });
});

describe('provisioning status', () => {
  it('a failed watcher run is shown per user and overall; retry raises the generation', async () => {
    await invite('anna');
    h.watcher.fail = true;
    h.watcher.run();
    const l = await h.service.listUsers();
    expect(l.users[0]!.provisioning).toBe('failed');
    expect(l.lastProvisioning).toMatchObject({ state: 'failed', error: 'boom' });
    const gen = usersJson().generation;
    await h.service.reprovision('admin');
    expect(usersJson().generation).toBe(gen + 1);
    expect((await user('anna')).provisioning).toBe('pending');
    h.watcher.fail = false;
    h.watcher.run();
    expect((await user('anna')).provisioning).toBe('ok');
  });

  it('reports when MetaMCP was restarted', async () => {
    await invite('anna');
    h.watcher.run();
    await h.service.changeRole('admin', 'anna', 'writer');
    h.watcher.run();
    expect((await h.service.listUsers()).lastProvisioning).toMatchObject({ state: 'ok', restartMetamcp: true });
  });
});

describe('role change, disable, enable, remove, release', () => {
  it('role change swaps the groups and requests a key rotation (belt and braces)', async () => {
    await invite('anna', 'reader');
    h.watcher.run();
    const before = await h.service.revealKey('anna');
    await h.service.changeRole('admin', 'anna', 'writer');
    expect(h.ak.groupNamesOf(h.ak.userByName('anna')!.pk)).toEqual(['lokyy-users', 'vault-firma-write', 'vault-v01']);
    const u = usersJson().users[0];
    expect(u).toMatchObject({ role: 'writer' });
    expect(typeof u.keyRotation).toBe('string');
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ status: 409, code: 'key_not_provisioned' });
    h.watcher.run();
    expect(await h.service.revealKey('anna')).not.toBe(before);
  });

  it('disable deactivates in Authentik, ends sessions and drops the user from users.json; the slot stays taken', async () => {
    await invite('anna');
    h.ak.sessions.push({ uuid: 's1', username: 'anna' });
    await h.service.disable('admin', 'anna');
    expect(h.ak.userByName('anna')!.is_active).toBe(false);
    expect(h.ak.sessions).toEqual([]);
    expect(usersJson().users).toEqual([]);
    expect((await invite('ben')).user.slot).toBe('v02');
  });

  it('enable restores access (back in users.json)', async () => {
    await invite('anna');
    await h.service.markActive('anna');
    await h.service.disable('admin', 'anna');
    await h.service.enable('admin', 'anna');
    expect(h.ak.userByName('anna')!.is_active).toBe(true);
    expect((await user('anna')).status).toBe('active');
    expect(usersJson().users.map((u: { username: string }) => u.username)).toEqual(['anna']);
  });

  it('remove deletes the Authentik user, drops the user from users.json, keeps the data and blocks the slot', async () => {
    await invite('anna');
    await expect(h.service.remove('admin', 'anna', { confirm: 'wrong', keepData: true })).rejects.toMatchObject({ status: 400, code: 'confirm_mismatch' });
    await h.service.remove('admin', 'anna', { confirm: 'anna', keepData: true });
    expect(h.ak.userByName('anna')).toBeUndefined();
    expect(usersJson().users).toEqual([]);
    const list = await h.service.listUsers();
    expect(list.users).toEqual([]);
    expect(list.retired).toMatchObject([{ slot: 'v01', formerUsername: 'anna' }]);
    expect((await invite('ben')).user.slot).toBe('v02');
  });

  it('a removed user who is invited again gets their old slot (and data) back', async () => {
    await invite('anna');
    await h.service.remove('admin', 'anna', { confirm: 'anna', keepData: true });
    expect((await invite('anna')).user.slot).toBe('v01');
    expect((await h.service.listUsers()).retired).toEqual([]);
  });

  it('an admin can explicitly release a retired slot (typed confirmation); it is then assigned again', async () => {
    await invite('anna');
    await h.service.remove('admin', 'anna', { confirm: 'anna', keepData: true });
    await expect(h.service.releaseSlot('admin', 'v01', { confirm: 'v02' })).rejects.toMatchObject({ status: 400, code: 'confirm_mismatch' });
    await expect(h.service.releaseSlot('admin', 'v02', { confirm: 'v02' })).rejects.toMatchObject({ status: 404, code: 'slot_not_retired' });
    await h.service.releaseSlot('admin', 'v01', { confirm: 'v01' });
    expect((await h.service.listUsers()).retired).toEqual([]);
    expect((await invite('ben')).user.slot).toBe('v01');
    expect(audit().some((e) => e.action === 'slot.release' && e.target === 'v01')).toBe(true);
  });

  it('wiping vault data is refused (separate follow-up)', async () => {
    await invite('anna');
    await expect(h.service.remove('admin', 'anna', { confirm: 'anna', keepData: false })).rejects.toMatchObject({ status: 400, code: 'wipe_unsupported' });
    expect((await h.service.listUsers()).users).toHaveLength(1);
  });

  it('unknown users answer 404', async () => {
    await expect(h.service.changeRole('admin', 'nobody', 'writer')).rejects.toBeInstanceOf(ServiceError);
    await expect(h.service.disable('admin', 'nobody')).rejects.toMatchObject({ status: 404 });
  });
});

describe('my access (self service)', () => {
  it('returns links and the provisioned MCP URL for the caller', async () => {
    await invite('anna', 'reader');
    h.watcher.run();
    expect(await h.service.myAccess('anna')).toMatchObject({
      username: 'anna', slot: 'v01', role: 'reader', vaultUrl: 'https://v01.example.com', companyVaultUrl: null,
      mcpUrl: 'https://mcp.example.com/metamcp/anna/mcp', serverName: 'lokyy', provisioning: 'ok',
    });
    await invite('ben', 'writer');
    expect(await h.service.myAccess('ben')).toMatchObject({ companyVaultUrl: 'https://firma.example.com', provisioning: 'pending' });
  });

  it('uses the configured public URLs while nothing is provisioned yet', async () => {
    h.cleanup();
    h = harness({ siteUrl: (host) => `http://${host}.portal.localhost:18380`, mcpPublicBase: 'http://mcp.portal.localhost:18380' });
    await invite('anna', 'writer');
    expect(await h.service.myAccess('anna')).toMatchObject({
      vaultUrl: 'http://v01.portal.localhost:18380', companyVaultUrl: 'http://firma.portal.localhost:18380',
      mcpUrl: 'http://mcp.portal.localhost:18380/metamcp/anna/mcp',
    });
  });

  it('the first visit marks an invited user active', async () => {
    await invite('anna');
    await h.service.myAccess('anna');
    expect((await user('anna')).status).toBe('active');
  });

  it('unknown or disabled callers have no access record', async () => {
    await expect(h.service.myAccess('ghost')).rejects.toMatchObject({ status: 404 });
    await invite('anna');
    await h.service.disable('admin', 'anna');
    await expect(h.service.myAccess('anna')).rejects.toMatchObject({ status: 403 });
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ status: 403 });
  });

  it('reveal answers key_not_provisioned while pending and provisioning_failed after a failed run', async () => {
    await invite('anna');
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ status: 409, code: 'key_not_provisioned' });
    h.watcher.fail = true;
    h.watcher.run();
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ status: 502, code: 'provisioning_failed' });
  });

  it('regenerate requests a rotation for the caller only; the new key appears after the watcher ran', async () => {
    await invite('anna'); await invite('ben');
    h.watcher.run();
    const [a, b] = [await h.service.revealKey('anna'), await h.service.revealKey('ben')];
    expect(await h.service.rotateKey('anna')).toEqual({ pending: true });
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ code: 'key_not_provisioned' });
    expect(await h.service.revealKey('ben')).toBe(b);
    h.watcher.run();
    const fresh = await h.service.revealKey('anna');
    expect(fresh).not.toBe(a);
    expect(await h.service.revealKey('ben')).toBe(b);
    expect(audit().some((e) => e.action === 'key.rotate' && e.actor === 'anna')).toBe(true);
  });
});
