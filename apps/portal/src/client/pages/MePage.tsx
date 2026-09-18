import { useEffect, useState } from 'react';
import { ExternalLink, Eye, EyeOff, KeyRound, RefreshCw } from 'lucide-react';
import { de } from '../../shared/i18n/de.ts';
import { ApiError, errorMessage } from '../api.ts';
import { useApi, useLoad, usePolling } from '../context.tsx';
import { claudeCodeCommand, claudeDesktopConfig } from '../snippets.ts';
import type { MyAccess } from '../types.ts';
import { Alert, Button, Card, CopyBlock, Dialog, LoadError, Loading } from '../components/ui.tsx';

const t = de.me;

function VaultLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-line p-4">
      <a href={href} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-2 self-start rounded text-base font-semibold text-link underline-offset-2 hover:underline">
        {label}<ExternalLink aria-hidden className="h-4 w-4" /><span className="sr-only"> {t.opensNewTab}</span>
      </a>
      <span className="text-sm text-muted">{hint}</span>
      <span className="font-mono text-xs text-muted">{href}</span>
    </li>
  );
}

export function MePage({ pollMs = 3000 }: { pollMs?: number }) {
  const api = useApi();
  const { data, error, loading, reload, version } = useLoad((a) => a.get<MyAccess>('/api/me'));
  /** set after "regenerate": the load version at that time; the new key is revealed once a later load says ok */
  const [rotatedAt, setRotatedAt] = useState<number | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<'reveal' | 'rotate' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const waiting = rotatedAt !== null || data?.provisioning === 'pending';
  usePolling(waiting, pollMs, reload);
  useEffect(() => {
    if (rotatedAt === null || !data || version <= rotatedAt || data.provisioning === 'pending') return;
    setRotatedAt(null);
    if (data.provisioning === 'failed') { setBusy(null); setNotice({ tone: 'error', text: t.failed }); return; }
    void api.post<{ apiKey: string }>('/api/me/key/reveal').then(
      (r) => { setKey(r.apiKey); setNotice({ tone: 'success', text: t.regenerated }); },
      (e: unknown) => setNotice({ tone: 'error', text: errorMessage(e) }),
    ).finally(() => setBusy(null));
  }, [api, data, rotatedAt, version]);

  if (loading && !data) return <Loading />;
  if (error instanceof ApiError && (error.code === 'no_access' || error.code === 'disabled')) {
    return <Card title={t.title}><Alert tone="info">{errorMessage(error)}</Alert></Card>;
  }
  if (error || !data) return <LoadError message={errorMessage(error)} onRetry={reload} />;

  const reveal = async () => {
    setBusy('reveal');
    setNotice(null);
    try {
      setKey((await api.post<{ apiKey: string }>('/api/me/key/reveal')).apiKey);
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const rotate = async () => {
    setBusy('rotate');
    setNotice({ tone: 'success', text: t.rotating });
    setKey(null);
    try {
      await api.post('/api/me/key/rotate');
      setRotatedAt(version);
      reload();
    } catch (e) {
      setBusy(null);
      setNotice({ tone: 'error', text: errorMessage(e) });
    }
  };
  const ready = data.provisioning === 'ok';
  const snippet = { name: data.serverName, url: data.mcpUrl, apiKey: key };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-fg">{t.greeting(data.displayName)}</h1>
        {data.companyName && <p className="text-sm text-muted">{data.companyName}</p>}
      </header>

      <Card title={t.vaults}>
        <ul className="grid gap-3 sm:grid-cols-2">
          <VaultLink href={data.vaultUrl} label={t.ownVault} hint={t.ownVaultHint} />
          {data.companyVaultUrl
            ? <VaultLink href={data.companyVaultUrl} label={t.companyVault} hint={t.companyVaultHintWriter} />
            : (
              <li className="flex flex-col gap-1 rounded-md border border-dashed border-line p-4">
                <span className="text-base font-semibold text-fg">{t.companyVault}</span>
                <span className="text-sm text-muted">{t.companyVaultHintReader}</span>
              </li>
            )}
        </ul>
      </Card>

      <Card title={t.mcp}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t.mcpIntro}</p>
          <CopyBlock label={t.mcpUrl} value={data.mcpUrl} />

          <div className="flex flex-col gap-2">
            {data.provisioning === 'pending' && rotatedAt === null && <Alert tone="info">{t.pending}</Alert>}
            {data.provisioning === 'failed' && rotatedAt === null && <Alert tone="error">{t.failed}</Alert>}
            {!key && <span className="text-sm font-medium text-fg">{t.apiKey}</span>}
            {key
              ? <CopyBlock label={t.apiKey} value={key} />
              : <p className="flex items-center gap-2 rounded-md border border-line bg-input px-3 py-2 text-sm text-muted"><KeyRound aria-hidden className="h-4 w-4" />{t.keyHidden}</p>}
            <div className="flex flex-wrap gap-2">
              {key
                ? <Button variant="secondary" onClick={() => setKey(null)}><EyeOff aria-hidden className="h-4 w-4" />{t.hide}</Button>
                : ready && <Button variant="secondary" busy={busy === 'reveal'} onClick={() => void reveal()}><Eye aria-hidden className="h-4 w-4" />{t.reveal}</Button>}
              {ready && <Button variant="secondary" busy={busy === 'rotate'} onClick={() => setConfirmRotate(true)}><RefreshCw aria-hidden className="h-4 w-4" />{t.regenerate}</Button>}
              {busy === 'rotate' && !ready && <Button variant="secondary" busy disabled>{t.regenerate}</Button>}
            </div>
            <p className="text-xs text-muted">{t.keyWarning}</p>
            {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
          </div>

          <div className="flex flex-col gap-4 border-t border-line pt-4">
            {!key && <p className="text-sm text-muted">{t.placeholderHint}</p>}
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-fg">{t.claudeCode}</h3>
              <CopyBlock label={t.claudeCodeHint} value={claudeCodeCommand(snippet)} />
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-fg">{t.claudeDesktop}</h3>
              <CopyBlock label={t.claudeDesktopHint} value={claudeDesktopConfig(snippet)} multiline />
            </div>
          </div>
        </div>
      </Card>

      <Dialog open={confirmRotate} title={t.regenerate} onClose={() => setConfirmRotate(false)}>
        <p className="text-sm text-fg">{t.regenerateConfirm}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmRotate(false)}>{de.common.cancel}</Button>
          <Button variant="danger" onClick={() => { setConfirmRotate(false); void rotate(); }}>{t.regenerate}</Button>
        </div>
      </Dialog>
    </div>
  );
}
