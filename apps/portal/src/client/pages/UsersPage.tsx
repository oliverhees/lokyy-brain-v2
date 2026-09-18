import { useState, type FormEvent } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { de } from '../../shared/i18n/de.ts';
import { ApiError, errorMessage } from '../api.ts';
import { useApi, useLoad, usePolling } from '../context.tsx';
import type { InviteResponse, Role, UserRow, UsersResponse } from '../types.ts';
import { Alert, Badge, Button, Card, CopyBlock, Dialog, LoadError, Loading, RadioGroup, TextField, fieldError } from '../components/ui.tsx';

const t = de.users;

/** "Jürgen Müller" → "juergen-mueller" (the username rule of the portal) */
export function suggestUsername(name: string): string {
  const s = name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 31).replace(/-+$/, '');
  return s;
}

function StatusBadge({ u }: { u: UserRow }) {
  if (u.status === 'disabled') return <Badge tone="neutral">{de.status.disabled}</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone={u.status === 'active' ? 'success' : 'accent'}>{de.status[u.status]}</Badge>
      {u.provisioning === 'failed' && <Badge tone="danger">{de.status.provisioningFailed}</Badge>}
      {u.provisioning === 'pending' && <Badge tone="warning">{de.status.provisioningPending}</Badge>}
    </span>
  );
}

// ------------------------------------------------------------------ invite
function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: () => void }) {
  const api = useApi();
  const [form, setForm] = useState({ displayName: '', email: '', username: '', role: 'reader' as Role });
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResponse | null>(null);

  const close = () => {
    setForm({ displayName: '', email: '', username: '', role: 'reader' });
    setUsernameTouched(false); setFields({}); setFormError(null); setResult(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setFields({}); setFormError(null);
    try {
      const r = await api.post<InviteResponse>('/api/admin/users', form);
      setResult(r);
      onInvited();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_input') setFields(err.fields);
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={result ? t.invited.heading : t.form.heading} onClose={close}>
      {result ? (
        <div className="flex flex-col gap-4">
          {result.mailed
            ? <Alert tone="success">{t.invited.mailed(result.user.email)}</Alert>
            : <Alert tone={result.mailError ? 'warning' : 'info'}>{result.mailError ? t.invited.mailFailed : t.invited.notMailed}</Alert>}
          <CopyBlock label={t.invited.link} value={result.inviteLink} />
          <div className="flex justify-end"><Button onClick={close}>{de.common.close}</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <TextField label={t.form.displayName} autoComplete="off" value={form.displayName} required error={fieldError(fields, 'displayName')}
            onChange={(e) => {
              const displayName = e.target.value;
              setForm((f) => ({ ...f, displayName, username: usernameTouched ? f.username : suggestUsername(displayName) }));
            }} />
          <TextField label={t.form.email} type="email" autoComplete="off" value={form.email} required error={fieldError(fields, 'email')}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          <TextField label={t.form.username} autoComplete="off" spellCheck={false} value={form.username} required hint={t.form.usernameHint}
            error={fieldError(fields, 'username')}
            onChange={(e) => { setUsernameTouched(true); setForm((f) => ({ ...f, username: e.target.value })); }} />
          <RadioGroup legend={t.form.role} name="role" value={form.role} onChange={(role) => setForm((f) => ({ ...f, role }))}
            options={[{ value: 'reader', label: de.roles.reader, hint: de.roles.readerHint }, { value: 'writer', label: de.roles.writer, hint: de.roles.writerHint }]} />
          {formError && <Alert tone="error">{formError}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>{de.common.cancel}</Button>
            <Button type="submit" busy={busy}>{busy ? t.form.submitting : t.form.submit}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ page
type Pending = { kind: 'remove' | 'disable'; user: UserRow } | { kind: 'release'; slot: string; formerUsername: string } | null;

export function UsersPage({ pollMs = 3000 }: { pollMs?: number }) {
  const api = useApi();
  const { data, error, loading, reload } = useLoad((a) => a.get<UsersResponse>('/api/admin/users'));
  // Provisioning happens in the metamcp container; follow it until nothing is pending.
  usePolling(!!data && (data.lastProvisioning?.state === 'pending' || data.users.some((u) => u.provisioning === 'pending')), pollMs, reload);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmText, setConfirmText] = useState('');
  const [link, setLink] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusyKey(key); setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'success', text: done });
      reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusyKey(null);
    }
  };
  const path = (u: UserRow) => `/api/admin/users/${encodeURIComponent(u.username)}`;

  if (loading && !data) return <Loading />;
  if (error && !data) return <LoadError message={errorMessage(error)} onRetry={reload} />;
  const d = data!;
  const needsRetry = d.lastProvisioning?.state === 'failed' || d.users.some((u) => u.provisioning === 'failed');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t.title}</h1>
          <p className="text-sm text-muted">{t.slots(d.freeSlots)}</p>
        </div>
        <Button onClick={() => setInviteOpen(true)} disabled={d.freeSlots === 0 && d.retired.length === 0}>
          <UserPlus aria-hidden className="h-4 w-4" />{t.invite}
        </Button>
      </header>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {needsRetry && (
        <Alert tone="warning" action={<Button variant="secondary" busy={busyKey === 'provision'}
          onClick={() => act('provision', () => api.post('/api/admin/provision'), t.done.reprovisioned)}>{t.actions.retry}</Button>}>
          {t.provisioningWarning}
        </Alert>
      )}
      {d.lastProvisioning?.restartMetamcp && <Alert tone="info">{t.restartHint}</Alert>}

      {d.users.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Users aria-hidden className="h-8 w-8 text-muted" />
            <p className="text-base font-medium text-fg">{t.empty}</p>
            <p className="max-w-md text-sm text-muted">{t.emptyHint}</p>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t.table.caption}</caption>
            <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-fg">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">{t.table.name}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.table.vault}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.table.role}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.table.status}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.table.actions}</th>
              </tr>
            </thead>
            <tbody>
              {d.users.map((u) => (
                <tr key={u.username} className="border-b border-line-soft last:border-0 align-top">
                  <th scope="row" id={`row-${u.username}`} className="px-4 py-3 font-normal">
                    <span className="block font-medium text-fg">{u.displayName}</span>
                    <span className="block text-xs text-muted">{u.username} · {u.email}</span>
                  </th>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{u.slot}</td>
                  <td className="px-4 py-3 text-fg">{de.roles[u.role]}</td>
                  <td className="px-4 py-3"><StatusBadge u={u} /></td>
                  <td className="px-4 py-3">
                    <div role="group" aria-label={t.actions.menu(u.displayName)} className="flex flex-wrap gap-1">
                      {u.status === 'invited' && (
                        <Button variant="ghost" aria-describedby={`row-${u.username}`} busy={busyKey === `resend-${u.username}`}
                          onClick={() => act(`resend-${u.username}`, async () => setLink((await api.post<{ inviteLink: string }>(`${path(u)}/invite`)).inviteLink), t.done.resent)}>
                          {t.actions.resend}
                        </Button>
                      )}
                      {u.status !== 'disabled' && (
                        <Button variant="ghost" aria-describedby={`row-${u.username}`} busy={busyKey === `role-${u.username}`}
                          onClick={() => act(`role-${u.username}`, () => api.patch(path(u), { role: u.role === 'reader' ? 'writer' : 'reader' }), t.done.role)}>
                          {u.role === 'reader' ? t.actions.makeWriter : t.actions.makeReader}
                        </Button>
                      )}
                      {u.status === 'disabled'
                        ? <Button variant="ghost" aria-describedby={`row-${u.username}`} busy={busyKey === `enable-${u.username}`}
                            onClick={() => act(`enable-${u.username}`, () => api.post(`${path(u)}/enable`), t.done.enabled)}>{t.actions.enable}</Button>
                        : <Button variant="ghost" aria-describedby={`row-${u.username}`} onClick={() => setPending({ kind: 'disable', user: u })}>{t.actions.disable}</Button>}
                      <Button variant="ghost-danger" aria-describedby={`row-${u.username}`} onClick={() => { setConfirmText(''); setPending({ kind: 'remove', user: u }); }}>{t.actions.remove}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.retired.length > 0 && (
        <Card title={t.retired.heading}>
          <p className="mb-2 text-sm text-muted">{t.retired.text}</p>
          <ul className="flex flex-col gap-1 text-sm text-fg">
            {d.retired.map((r) => (
              <li key={r.slot} className="flex flex-wrap items-center gap-2">
                <span>{t.retired.entry(r.slot, r.formerUsername)}</span>
                <Button variant="ghost" onClick={() => { setConfirmText(''); setPending({ kind: 'release', slot: r.slot, formerUsername: r.formerUsername }); }}>
                  {t.retired.release}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={reload} />

      <Dialog open={link !== null} title={t.invited.heading} onClose={() => setLink(null)}>
        <Alert tone="info">{t.invited.notMailed}</Alert>
        {link && <CopyBlock label={t.invited.link} value={link} />}
        <div className="flex justify-end"><Button onClick={() => setLink(null)}>{de.common.close}</Button></div>
      </Dialog>

      <Dialog open={pending?.kind === 'disable'} title={pending?.kind === 'disable' ? t.disableDialog.heading(pending.user.displayName) : ''} onClose={() => setPending(null)}>
        <p className="text-sm text-fg">{t.disableDialog.text}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{de.common.cancel}</Button>
          <Button variant="danger" onClick={() => {
            if (pending?.kind !== 'disable') return;
            const u = pending.user; setPending(null);
            void act(`disable-${u.username}`, () => api.post(`${path(u)}/disable`), t.done.disabled);
          }}>{t.disableDialog.confirm}</Button>
        </div>
      </Dialog>

      <Dialog open={pending?.kind === 'remove'} title={pending?.kind === 'remove' ? t.removeDialog.heading(pending.user.displayName) : ''} onClose={() => setPending(null)}>
        <p className="text-sm text-fg">{t.removeDialog.text}</p>
        {pending?.kind === 'remove' && <TextField label={t.removeDialog.confirmLabel(pending.user.username)} value={confirmText} autoComplete="off" spellCheck={false}
          onChange={(e) => setConfirmText(e.target.value)} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{de.common.cancel}</Button>
          <Button variant="danger" disabled={pending?.kind !== 'remove' || confirmText !== pending.user.username} onClick={() => {
            if (pending?.kind !== 'remove') return;
            const u = pending.user; setPending(null);
            void act(`remove-${u.username}`, () => api.del(path(u), { confirm: confirmText, keepData: true }), t.done.removed);
          }}>{t.removeDialog.confirm}</Button>
        </div>
      </Dialog>
      <Dialog open={pending?.kind === 'release'} title={pending?.kind === 'release' ? t.releaseDialog.heading(pending.slot) : ''} onClose={() => setPending(null)}>
        {pending?.kind === 'release' && (
          <>
            <Alert tone="warning">{t.releaseDialog.text(pending.formerUsername)}</Alert>
            <TextField label={t.releaseDialog.confirmLabel(pending.slot)} value={confirmText} autoComplete="off" spellCheck={false}
              onChange={(e) => setConfirmText(e.target.value)} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{de.common.cancel}</Button>
          <Button variant="danger" disabled={pending?.kind !== 'release' || confirmText !== pending.slot} onClick={() => {
            if (pending?.kind !== 'release') return;
            const slot = pending.slot; setPending(null);
            void act(`release-${slot}`, () => api.post(`/api/admin/slots/${encodeURIComponent(slot)}/release`, { confirm: confirmText }), t.done.released);
          }}>{t.releaseDialog.confirm}</Button>
        </div>
      </Dialog>
    </div>
  );
}
