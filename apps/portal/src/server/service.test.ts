import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, type Harness } from '../../test/fakes/harness.ts';
import { ServiceError } from './service.ts';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const invite = (username: string, role: 'reader' | 'writer' = 'reader') =>
  h.service.invite('admin', { username, email: `${username}@example.com`, displayName: `${username} Name`, role });

const audit = () => readFileSync(join(h.dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('setup wizard', () => {
  it('stores the company name', async () => {
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    expect((await h.service.setupStatus()).company).toEqual({ name: 'Muster GmbH' });
  });

  it('rejects an invalid company name', async () => {
    await expect(h.service.setCompany('admin', { name: '' })).rejects.toMatchObject({ status: 400, fields: { name: 'required' } });
  });

  it('shared EUrouter key goes to every slot and the company vault; only a masked hint is kept', async () => {
    const r = await h.service.setLlm('admin', { mode: 'shared', model: 'mistral/mistral-small', sharedKey: 'sk-eu-abcdefghijkl1234' });
    expect(r.failed).toEqual([]);
    expect(h.vaults.calls.map((c) => c.vault).sort()).toEqual(['firma', 'v01', 'v02', 'v03']);
    expect(new Set(h.vaults.calls.map((c) => c.apiKey))).toEqual(new Set(['sk-eu-abcdefghijkl1234']));
    const status = await h.service.setupStatus();
    expect(status.llm?.keyHints).toEqual({ firma: '••••1234', v01: '••••1234', v02: '••••1234', v03: '••••1234' });
    expect(readFileSync(join(h.dir, 'state.json'), 'utf8')).not.toContain('abcdefghijkl');
    expect(JSON.stringify(audit())).not.toContain('abcdefghijkl');
  });

  it('per-vault keys: only the vaults given are configured', async () => {
    await h.service.setLlm('admin', { mode: 'per-vault', model: 'm', keys: { firma: 'sk-firma-000000001', v02: 'sk-v02-0000000002' } });
    expect(h.vaults.calls.map((c) => [c.vault, c.apiKey])).toEqual([['firma', 'sk-firma-000000001'], ['v02', 'sk-v02-0000000002']]);
  });

  it('rejects keys for unknown vaults and invalid keys before touching any vault', async () => {
    await expect(h.service.setLlm('admin', { mode: 'per-vault', model: 'm', keys: { v99: 'sk-000000000000' } })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.setLlm('admin', { mode: 'shared', model: 'm', sharedKey: 'short' })).rejects.toMatchObject({ status: 400 });
    expect(h.vaults.calls).toEqual([]);
  });

  it('reports vaults that could not be configured and keeps the hints of the others', async () => {
    h.vaults.failFor.add('v02');
    const r = await h.service.setLlm('admin', { mode: 'shared', model: 'm', sharedKey: 'sk-eu-abcdefghijkl1234' });
    expect(r.failed).toEqual(['v02']);
    expect(Object.keys((await h.service.setupStatus()).llm!.keyHints).sort()).toEqual(['firma', 'v01', 'v03']);
  });

  it('SMTP: password stored as secret, never returned', async () => {
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'mail-pass-123', from: 'noreply@example.com' });
    const s = await h.service.setupStatus();
    expect(s.smtp).toMatchObject({ host: 'smtp.example.com', passwordSet: true });
    expect(JSON.stringify(s)).not.toContain('mail-pass-123');
    expect(readFileSync(join(h.dir, 'state.json'), 'utf8')).not.toContain('mail-pass-123');
  });

  it('SMTP update without password keeps the stored one; removal deletes it', async () => {
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'mail-pass-123', from: 'noreply@example.com' });
    await h.service.setSmtp('admin', { host: 'smtp2.example.com', port: 465, secure: true, username: 'u', from: 'noreply@example.com' });
    expect((await h.store.readSecrets()).smtpPassword).toBe('mail-pass-123');
    await h.service.removeSmtp('admin');
    expect((await h.service.setupStatus()).smtp).toBeNull();
    expect((await h.store.readSecrets()).smtpPassword).toBeUndefined();
  });

  it('setup can only be completed once company and LLM are set', async () => {
    await expect(h.service.completeSetup('admin')).rejects.toMatchObject({ status: 409 });
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    await h.service.setLlm('admin', { mode: 'shared', model: 'm', sharedKey: 'sk-eu-abcdefghijkl1234' });
    await h.service.completeSetup('admin');
    expect((await h.service.setupStatus()).setupCompletedAt).not.toBeNull();
  });
});

describe('invite', () => {
  it('assigns the next free slot, creates the Authentik user with groups, provisions MetaMCP and returns a link', async () => {
    const r = await invite('anna', 'reader');
    expect(r.user).toMatchObject({ slot: 'v01', username: 'anna', status: 'invited', provisioning: 'ok' });
    expect(r.inviteLink).toContain('flow_token=');
    expect(r.mailed).toBe(false);
    const akUser = h.ak.userByName('anna')!;
    expect(h.ak.groupNamesOf(akUser.pk)).toEqual(['vault-firma-read', 'vault-v01']);
    expect(h.mm.serversOf('lokyy-anna').map((s) => s.url)).toContain('http://mcp.vault-v01:4322/mcp');
    const second = await invite('ben', 'writer');
    expect(second.user.slot).toBe('v02');
    expect(h.ak.groupNamesOf(h.ak.userByName('ben')!.pk)).toEqual(['vault-firma-write', 'vault-v02']);
  });

  it('mails the link when SMTP is configured', async () => {
    await h.service.setCompany('admin', { name: 'Muster GmbH' });
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'pw', from: 'noreply@example.com' });
    const r = await invite('anna');
    expect(r.mailed).toBe(true);
    expect(h.mailer.sent[0]).toMatchObject({ to: 'anna@example.com' });
    expect(h.mailer.sent[0]!.text).toContain(r.inviteLink);
    expect(h.mailer.sent[0]!.subject).toContain('Muster GmbH');
  });

  it('a mail failure does not fail the invitation', async () => {
    await h.service.setSmtp('admin', { host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'pw', from: 'noreply@example.com' });
    h.mailer.fail = true;
    const r = await invite('anna');
    expect(r.mailed).toBe(false);
    expect(r.mailError).toBe(true);
    expect(r.user.status).toBe('invited');
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

  it('frees the reserved slot when Authentik refuses the user', async () => {
    h.ak.addUser({ username: 'anna', attributes: {} }); // foreign account
    await expect(invite('anna')).rejects.toMatchObject({ status: 409, code: 'username_taken' });
    expect((await h.service.listUsers()).users).toEqual([]);
    expect((await invite('ben')).user.slot).toBe('v01');
  });

  it('keeps the user (provisioning failed) when MetaMCP fails, and a retry fixes it', async () => {
    h.mm.failProc = 'endpoints.create';
    const r = await invite('anna');
    expect(r.user.provisioning).toBe('failed');
    h.mm.failProc = null;
    await h.service.reprovision('admin');
    expect((await h.service.listUsers()).users[0]!.provisioning).toBe('ok');
  });

  it('parallel invitations never share a slot', async () => {
    const rs = await Promise.all(['anna', 'ben', 'carl'].map((u) => invite(u)));
    expect(rs.map((r) => r.user.slot).sort()).toEqual(['v01', 'v02', 'v03']);
  });

  it('resend creates a fresh link for invited users only', async () => {
    await invite('anna');
    const r = await h.service.resendInvite('admin', 'anna');
    expect(r.inviteLink).toContain('flow_token=');
    await h.service.markActive('anna');
    await expect(h.service.resendInvite('admin', 'anna')).rejects.toMatchObject({ status: 409 });
    await expect(h.service.resendInvite('admin', 'nobody')).rejects.toMatchObject({ status: 404 });
  });

  it('writes an audit entry without secrets or links', async () => {
    const r = await invite('anna');
    const entry = audit().find((e) => e.action === 'user.invite');
    expect(entry).toMatchObject({ actor: 'admin', target: 'anna', details: { slot: 'v01', role: 'reader' } });
    expect(JSON.stringify(audit())).not.toContain(r.inviteLink);
  });
});

describe('role change, disable, enable, remove', () => {
  it('role change swaps the company groups and rotates the MCP key', async () => {
    await invite('anna', 'reader');
    const before = await h.service.revealKey('anna');
    await h.service.changeRole('admin', 'anna', 'writer');
    expect(h.ak.groupNamesOf(h.ak.userByName('anna')!.pk)).toEqual(['vault-firma-write', 'vault-v01']);
    expect(h.mm.serversOf('lokyy-anna')[1]!.bearerToken).toBe('tok-firma');
    expect(await h.service.revealKey('anna')).not.toBe(before);
  });

  it('disable deactivates in Authentik, ends sessions and revokes the MCP key; the slot stays taken', async () => {
    await invite('anna');
    h.ak.sessions.push({ uuid: 's1', username: 'anna' });
    await h.service.disable('admin', 'anna');
    expect(h.ak.userByName('anna')!.is_active).toBe(false);
    expect(h.ak.sessions).toEqual([]);
    expect(await h.mm.db.query('select key from api_keys where user_id = $1 and name = $2', ['lokyy-anna', 'lokyy']).then((r) => r.rows)).toEqual([]);
    expect((await invite('ben')).user.slot).toBe('v02');
  });

  it('enable restores access with a new key', async () => {
    await invite('anna');
    await h.service.markActive('anna');
    await h.service.disable('admin', 'anna');
    await h.service.enable('admin', 'anna');
    expect(h.ak.userByName('anna')!.is_active).toBe(true);
    expect((await h.service.listUsers()).users[0]!.status).toBe('active');
    expect(await h.service.revealKey('anna')).toMatch(/^sk_mt_/);
  });

  it('remove deletes Authentik user and MetaMCP account, keeps the data and blocks the slot', async () => {
    await invite('anna');
    await expect(h.service.remove('admin', 'anna', { confirm: 'wrong', keepData: true })).rejects.toMatchObject({ status: 400, code: 'confirm_mismatch' });
    await h.service.remove('admin', 'anna', { confirm: 'anna', keepData: true });
    expect(h.ak.userByName('anna')).toBeUndefined();
    expect(h.mm.users.has('lokyy-anna')).toBe(false);
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

  it('wiping vault data is refused until the vault offers it', async () => {
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
  it('returns links, MCP URL and snippets context for the caller only', async () => {
    await invite('anna', 'reader');
    const me = await h.service.myAccess('anna');
    expect(me).toMatchObject({
      username: 'anna', slot: 'v01', role: 'reader',
      vaultUrl: 'https://v01.example.com', companyVaultUrl: null,
      mcpUrl: 'https://mcp.example.com/metamcp/anna/mcp', serverName: 'lokyy',
    });
    await invite('ben', 'writer');
    expect((await h.service.myAccess('ben')).companyVaultUrl).toBe('https://firma.example.com');
  });

  it('the first visit marks an invited user active', async () => {
    await invite('anna');
    await h.service.myAccess('anna');
    expect((await h.service.listUsers()).users[0]!.status).toBe('active');
  });

  it('unknown or disabled callers have no access record', async () => {
    await expect(h.service.myAccess('ghost')).rejects.toMatchObject({ status: 404 });
    await invite('anna');
    await h.service.disable('admin', 'anna');
    await expect(h.service.myAccess('anna')).rejects.toMatchObject({ status: 403 });
    await expect(h.service.revealKey('anna')).rejects.toMatchObject({ status: 403 });
  });

  it('regenerate issues a new key for the caller only', async () => {
    await invite('anna'); await invite('ben');
    const [a, b] = [await h.service.revealKey('anna'), await h.service.revealKey('ben')];
    const fresh = await h.service.rotateKey('anna');
    expect(fresh).not.toBe(a);
    expect(await h.service.revealKey('anna')).toBe(fresh);
    expect(await h.service.revealKey('ben')).toBe(b);
    expect(audit().some((e) => e.action === 'key.rotate' && e.actor === 'anna')).toBe(true);
  });
});
