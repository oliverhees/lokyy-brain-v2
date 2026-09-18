import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { de } from '../../shared/i18n/de.ts';
import { EUROUTER_BASE_URL } from '../../shared/validation.ts';
import { ApiError, errorMessage } from '../api.ts';
import { useApi, useLoad } from '../context.tsx';
import type { Route, SetupStatus, VaultLlm } from '../types.ts';
import { Alert, Button, Card, LoadError, Loading, RadioGroup, SelectField, TextField, fieldError } from '../components/ui.tsx';

const t = de.setup;
const STEPS = [t.steps.company, t.steps.llm, t.steps.smtp, t.steps.done];

function firstOpenStep(s: SetupStatus): number {
  if (!s.company) return 0;
  if (!s.llm) return 1;
  return s.setupCompletedAt ? 0 : 2;
}

function Stepper({ step }: { step: number }) {
  return (
    <nav aria-label={t.stepsLabel}>
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${i === step ? 'border-accent bg-accent-soft font-semibold text-fg' : 'border-line text-muted'}`}>
            <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-xs">
              {i < step ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** EUrouter key + "load routes" + route picker; routes are fetched server-side (validates the key). */
function KeyAndRoute({ keyLabel, routeLabel, value, onChange, current, fields, prefix }: {
  keyLabel: string; routeLabel: string; value: { apiKey: string; ruleId: string; routes: Route[] | null };
  onChange: (v: { apiKey: string; ruleId: string; routes: Route[] | null }) => void;
  current: VaultLlm | undefined; fields: Record<string, string>; prefix: string;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ apiKey?: string; general?: string }>({});
  const load = async () => {
    setBusy(true); setErr({});
    try {
      const r = await api.post<{ routes: Route[] }>('/api/admin/setup/llm/routes', { apiKey: value.apiKey.trim() });
      onChange({ ...value, routes: r.routes, ruleId: r.routes.some((x) => x.id === value.ruleId) ? value.ruleId : '' });
    } catch (e) {
      if (e instanceof ApiError && e.fields['apiKey']) setErr({ apiKey: fieldError(e.fields, 'apiKey') });
      else setErr({ general: errorMessage(e) });
      onChange({ ...value, routes: null, ruleId: '' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {current && <p className="text-sm text-muted">{t.llm.current(current.ruleName, current.keyHint)}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <TextField className="flex-1" label={keyLabel} type="password" autoComplete="off" spellCheck={false} value={value.apiKey}
          hint={current ? t.llm.keepHint : undefined} error={err.apiKey ?? fieldError(fields, `${prefix}apiKey`)}
          onChange={(e) => onChange({ apiKey: e.target.value, ruleId: '', routes: null })} />
        <Button variant="secondary" busy={busy} disabled={value.apiKey.trim().length === 0} onClick={() => void load()}>{t.llm.loadRoutes}</Button>
      </div>
      {err.general && <Alert tone="error">{err.general}</Alert>}
      {value.routes && value.routes.length === 0 && <Alert tone="warning">{t.llm.noRoutes}</Alert>}
      <SelectField label={routeLabel} placeholder={t.llm.chooseRoute} value={value.ruleId} disabled={!value.routes || value.routes.length === 0}
        hint={value.routes ? undefined : t.llm.routeHint} error={fieldError(fields, `${prefix}ruleId`)}
        options={(value.routes ?? []).map((r) => ({ value: r.id, label: r.name }))} onChange={(ruleId) => onChange({ ...value, ruleId })} />
    </div>
  );
}

type KeyRoute = { apiKey: string; ruleId: string; routes: Route[] | null };
const emptyKeyRoute = (): KeyRoute => ({ apiKey: '', ruleId: '', routes: null });

function StepFrame({ heading, children, error, footer, onSubmit }:
  { heading: string; children: ReactNode; error: string | null; footer: ReactNode; onSubmit: (e: FormEvent) => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const id = useId();
  // Move focus to the new step's heading so screen reader users notice the step change.
  useEffect(() => { ref.current?.focus(); }, [heading]);
  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={id} className="flex flex-col gap-5">
      <h2 id={id} ref={ref} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">{heading}</h2>
      {children}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">{footer}</div>
    </form>
  );
}

export function SetupPage({ onDone, initialStep }: { onDone: () => void; initialStep?: number }) {
  const api = useApi();
  const { data, error, loading, reload } = useLoad((a) => a.get<SetupStatus>('/api/admin/setup'));
  const [step, setStep] = useState<number | null>(initialStep ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [stepError, setStepError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [company, setCompany] = useState('');
  const [llmMode, setLlmMode] = useState<'shared' | 'per-vault'>('shared');
  const [shared, setShared] = useState<KeyRoute>(emptyKeyRoute);
  const [perVault, setPerVault] = useState<Record<string, KeyRoute>>({});
  const [smtp, setSmtp] = useState({ host: '', port: '587', secure: false, username: '', password: '', from: '' });
  const [testTo, setTestTo] = useState('');
  const loadedMode = useRef(false);

  useEffect(() => {
    if (!data) return;
    setStep((s) => s ?? firstOpenStep(data));
    setCompany((c) => c || data.company?.name || '');
    if (data.llm && !loadedMode.current) { loadedMode.current = true; setLlmMode(data.llm.mode); }
    if (data.smtp) setSmtp((s) => (s.host ? s : { host: data.smtp!.host, port: String(data.smtp!.port), secure: data.smtp!.secure, username: data.smtp!.username, password: '', from: data.smtp!.from }));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <LoadError message={errorMessage(error)} onRetry={reload} />;
  const s = data!;
  const current = step ?? 0;

  const go = (n: number) => { setFields({}); setStepError(null); setNotice(null); setStep(n); };
  const save = async (key: string, fn: () => Promise<boolean | void>, next?: number) => {
    setBusy(key); setFields({}); setStepError(null); setNotice(null);
    try {
      const ok = await fn();
      if (ok !== false && next !== undefined) { reload(); go(next); }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setFields(e.fields);
      else setStepError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const smtpBody = () => ({
    host: smtp.host.trim(), port: Number(smtp.port), secure: smtp.secure, username: smtp.username.trim(),
    ...(smtp.password ? { password: smtp.password } : {}), from: smtp.from.trim(),
  });

  let body: ReactNode;
  if (current === 0) {
    body = (
      <StepFrame heading={t.company.heading} error={stepError}
        onSubmit={(e) => { e.preventDefault(); void save('company', () => api.put('/api/admin/setup/company', { name: company }).then(() => undefined), 1); }}
        footer={<><span />
          <Button type="submit" busy={busy === 'company'}>{de.common.next}</Button></>}>
        <TextField label={t.company.name} hint={t.company.nameHint} value={company} autoComplete="organization" required
          error={fieldError(fields, 'name')} onChange={(e) => setCompany(e.target.value)} />
      </StepFrame>
    );
  } else if (current === 1) {
    const stored = s.llm?.vaults ?? {};
    const submitLlm = async (): Promise<boolean> => {
      let payload: unknown;
      if (llmMode === 'shared') {
        if (!shared.apiKey && s.llm && s.llm.mode === 'shared') return true; // unchanged
        payload = { mode: 'shared', apiKey: shared.apiKey.trim(), ruleId: shared.ruleId };
      } else {
        const filled = Object.entries(perVault).filter(([, v]) => v.apiKey.trim());
        if (filled.length === 0 && s.llm) return true; // unchanged
        payload = { mode: 'per-vault', vaults: Object.fromEntries(filled.map(([v, x]) => [v, { apiKey: x.apiKey.trim(), ruleId: x.ruleId }])) };
      }
      const r = await api.put<{ failed: string[] }>('/api/admin/setup/llm', payload);
      setShared(emptyKeyRoute()); setPerVault({});
      if (r.failed.length > 0) { reload(); setStepError(t.llm.failed(r.failed.join(', '))); return false; }
      return true;
    };
    body = (
      <StepFrame heading={t.llm.heading} error={stepError}
        onSubmit={(e) => { e.preventDefault(); void save('llm', submitLlm, 2); }}
        footer={<><Button variant="secondary" onClick={() => go(0)}>{de.common.back}</Button>
          <Button type="submit" busy={busy === 'llm'}>{de.common.next}</Button></>}>
        <p className="text-sm text-muted">{t.llm.intro}</p>
        <p className="text-sm text-fg">{t.llm.endpoint}: <code className="rounded bg-subtle px-1 font-mono text-xs">{EUROUTER_BASE_URL}</code></p>
        <RadioGroup legend={t.llm.mode} name="llm-mode" value={llmMode} onChange={setLlmMode}
          options={[{ value: 'shared', label: t.llm.modeShared }, { value: 'per-vault', label: t.llm.modePerVault }]} />
        {llmMode === 'shared' ? (
          <KeyAndRoute keyLabel={t.llm.sharedKey} routeLabel={t.llm.route} value={shared} onChange={setShared}
            current={s.llm?.mode === 'shared' ? stored['firma'] : undefined} fields={fields} prefix="" />
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">{t.llm.perVaultSkip}</p>
            {s.vaults.map((v) => (
              <fieldset key={v} className="flex flex-col gap-3 rounded-md border border-line p-4">
                <legend className="px-1 text-sm font-semibold text-fg">{t.llm.vaultLegend(v)}</legend>
                <KeyAndRoute keyLabel={t.llm.keyFor(v)} routeLabel={t.llm.routeFor(v)} value={perVault[v] ?? emptyKeyRoute()}
                  onChange={(x) => setPerVault((p) => ({ ...p, [v]: x }))} current={stored[v]} fields={fields} prefix={`vaults.${v}.`} />
              </fieldset>
            ))}
            {fields['vaults'] && <Alert tone="error">{fieldError(fields, 'vaults')}</Alert>}
          </div>
        )}
      </StepFrame>
    );
  } else if (current === 2) {
    body = (
      <StepFrame heading={t.smtp.heading} error={stepError}
        onSubmit={(e) => { e.preventDefault(); void save('smtp', () => api.put('/api/admin/setup/smtp', smtpBody()).then(() => undefined), 3); }}
        footer={<><Button variant="secondary" onClick={() => go(1)}>{de.common.back}</Button>
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => go(3)}>{t.smtp.skip}</Button>
            <Button type="submit" busy={busy === 'smtp'}>{de.common.save}</Button>
          </span></>}>
        <p className="text-sm text-muted">{t.smtp.intro}</p>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <TextField label={t.smtp.host} value={smtp.host} autoComplete="off" spellCheck={false} error={fieldError(fields, 'host')}
            onChange={(e) => setSmtp((x) => ({ ...x, host: e.target.value }))} />
          <TextField label={t.smtp.port} inputMode="numeric" value={smtp.port} error={fieldError(fields, 'port')}
            onChange={(e) => setSmtp((x) => ({ ...x, port: e.target.value.replace(/\D/g, '') }))} />
        </div>
        <label className="flex items-start gap-3 text-sm text-fg">
          <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp((x) => ({ ...x, secure: e.target.checked }))}
            className="focus-ring mt-0.5 h-4 w-4 accent-[var(--portal-accent)]" aria-describedby="smtp-secure-hint" />
          <span>{t.smtp.secure}<span id="smtp-secure-hint" className="block text-xs text-muted">{t.smtp.secureHint}</span></span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t.smtp.username} optional value={smtp.username} autoComplete="off" error={fieldError(fields, 'username')}
            onChange={(e) => setSmtp((x) => ({ ...x, username: e.target.value }))} />
          <TextField label={t.smtp.password} optional type="password" value={smtp.password} autoComplete="new-password"
            hint={s.smtp?.passwordSet ? t.smtp.passwordKeep : undefined} error={fieldError(fields, 'password')}
            onChange={(e) => setSmtp((x) => ({ ...x, password: e.target.value }))} />
        </div>
        <TextField label={t.smtp.from} hint={t.smtp.fromHint} value={smtp.from} autoComplete="off" error={fieldError(fields, 'from')}
          onChange={(e) => setSmtp((x) => ({ ...x, from: e.target.value }))} />
        <div className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-end">
          <TextField className="flex-1" label={t.smtp.testTo} type="email" value={testTo} autoComplete="email" error={fieldError(fields, 'to')}
            onChange={(e) => setTestTo(e.target.value)} />
          <Button variant="secondary" busy={busy === 'smtp-test'} onClick={() => save('smtp-test', async () => {
            await api.put('/api/admin/setup/smtp', smtpBody());
            await api.post('/api/admin/setup/smtp/test', { to: testTo.trim() });
            setNotice(t.smtp.testSent);
          })}>{t.smtp.sendTest}</Button>
        </div>
        {notice && <Alert tone="success">{notice}</Alert>}
        {s.smtp && (
          <div>
            <Button variant="ghost-danger" busy={busy === 'smtp-remove'} onClick={() => save('smtp-remove', async () => {
              await api.del('/api/admin/setup/smtp');
              setSmtp({ host: '', port: '587', secure: false, username: '', password: '', from: '' });
              reload();
              setNotice(t.smtp.removed);
            })}>{t.smtp.remove}</Button>
          </div>
        )}
      </StepFrame>
    );
  } else {
    body = (
      <StepFrame heading={t.done.heading} error={stepError}
        onSubmit={(e) => { e.preventDefault(); void save('done', async () => { await api.post('/api/admin/setup/complete'); onDone(); }); }}
        footer={<><Button variant="secondary" onClick={() => go(2)}>{de.common.back}</Button>
          <Button type="submit" busy={busy === 'done'}>{s.setupCompletedAt ? t.done.toUsers : t.done.finish}</Button></>}>
        <p className="text-sm text-fg">{t.done.text}</p>
      </StepFrame>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-fg">{t.title}</h1>
        <p className="text-sm text-muted">{t.intro}</p>
      </header>
      <Stepper step={current} />
      <p className="text-sm text-muted" aria-live="polite">{t.stepOf(current + 1, STEPS.length)}</p>
      <Card>{body}</Card>
    </div>
  );
}
