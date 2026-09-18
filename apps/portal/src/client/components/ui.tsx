// Small set of accessible building blocks on native elements (button, input, fieldset, dialog).
// Styling only through Tailwind classes mapped to design tokens (tailwind.config.ts).
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Copy, Check, Info, Loader2, TriangleAlert } from 'lucide-react';
import { de } from '../../shared/i18n/de.ts';
import { fieldMessage } from '../api.ts';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'ghost-danger';
const variants: Record<Variant, string> = {
  primary: 'px-4 bg-accent text-accent-fg hover:opacity-90',
  secondary: 'px-4 bg-surface text-fg border border-line hover:bg-subtle',
  danger: 'px-4 bg-danger text-accent-fg hover:opacity-90',
  ghost: 'px-2 text-link hover:bg-subtle',
  'ghost-danger': 'px-2 text-danger hover:bg-danger-soft',
};

export function Button({ variant = 'primary', busy = false, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx('focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-md text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60', variants[variant], className)}
    >
      {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Text field
export function TextField({ label, hint, error, optional, className, ...input }:
  InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined; optional?: boolean }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}{optional && <span className="font-normal text-muted"> ({de.common.optional})</span>}
      </label>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        className={cx('focus-ring min-h-[40px] rounded-md border bg-input px-3 text-sm text-fg placeholder:text-muted',
          error ? 'border-danger' : 'border-control')}
      />
      {hint && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && <p id={errId} className="flex items-center gap-1 text-xs font-medium text-danger"><AlertCircle aria-hidden className="h-3.5 w-3.5" />{error}</p>}
    </div>
  );
}

/** Field error text for a server field code, or undefined. */
export const fieldError = (fields: Record<string, string>, name: string): string | undefined =>
  fields[name] ? fieldMessage(fields[name]!) : undefined;

// ------------------------------------------------------------------ Select
export function SelectField({ label, hint, error, options, placeholder, value, onChange, disabled }:
  { label: string; hint?: string | undefined; error?: string | undefined; options: { value: string; label: string }[]; placeholder: string;
    value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        className={cx('focus-ring min-h-[40px] rounded-md border bg-input px-3 text-sm text-fg disabled:opacity-60', error ? 'border-danger' : 'border-control')}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && <p id={errId} className="flex items-center gap-1 text-xs font-medium text-danger"><AlertCircle aria-hidden className="h-3.5 w-3.5" />{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Checkbox
export function CheckboxField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined}
        className="focus-ring mt-0.5 h-4 w-4 accent-[var(--portal-accent)]" />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
        {hint && <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Radio group
export function RadioGroup<T extends string>({ legend, name, value, options, onChange }:
  { legend: string; name: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)}
            className="focus-ring mt-0.5 h-4 w-4 accent-[var(--portal-accent)]" />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-fg">{o.label}</span>
            {o.hint && <span className="text-xs text-muted">{o.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ------------------------------------------------------------------ Alert
type Tone = 'info' | 'success' | 'error' | 'warning';
const tones: Record<Tone, { cls: string; Icon: typeof Info }> = {
  info: { cls: 'border-line bg-subtle text-fg', Icon: Info },
  success: { cls: 'border-success bg-success-soft text-success', Icon: CheckCircle2 },
  error: { cls: 'border-danger bg-danger-soft text-danger', Icon: AlertCircle },
  warning: { cls: 'border-warn bg-warn-soft text-warn', Icon: TriangleAlert },
};

export function Alert({ tone = 'info', children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  const { cls, Icon } = tones[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', cls)}>
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ Copy
export function CopyBlock({ label, value, multiline = false, id }: { label: string; value: string; multiline?: boolean; id?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const name = label.replace(/[:\s]+$/, '');
  const auto = useId();
  const valueId = id ?? `${auto}-value`;
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
  };
  return (
    <div className="flex flex-col gap-1">
      <span id={`${valueId}-label`} className="text-sm font-medium text-fg">{label}</span>
      <div className="flex items-stretch gap-2">
        <pre id={valueId} aria-labelledby={`${valueId}-label`} tabIndex={0}
          className={cx('focus-ring flex-1 overflow-x-auto rounded-md border border-line bg-input px-3 py-2 font-mono text-xs text-fg', multiline ? 'whitespace-pre' : 'whitespace-pre-wrap break-all')}>
          {value}
        </pre>
        <Button variant="secondary" onClick={copy} aria-label={`${name} ${de.common.copy.toLowerCase()}`} className="self-start">
          {state === 'copied' ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
          <span>{state === 'copied' ? de.common.copied : de.common.copy}</span>
        </Button>
      </div>
      <p aria-live="polite" className="min-h-[1rem] text-xs text-muted">
        {state === 'failed' ? de.common.copyFailed : state === 'copied' ? de.common.copiedAnnounce(name) : ''}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ Dialog (native <dialog>: focus trap + Esc)
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
    if (!open && d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}
      className="w-[min(560px,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/50">
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

// ------------------------------------------------------------------ misc
export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className="rounded-lg border border-line bg-surface p-5 shadow-sm">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 id={id} className="text-base font-semibold text-fg">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ label = de.app.loading }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" />{label}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Alert tone="error" action={<Button variant="secondary" onClick={onRetry}>{de.app.retry}</Button>}>{message}</Alert>;
}

export function Badge({ tone, children }: { tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'; children: ReactNode }) {
  const cls = { neutral: 'bg-strong text-fg', success: 'bg-success-soft text-success', warning: 'bg-warn-soft text-warn',
    danger: 'px-4 bg-danger-soft text-danger', accent: 'bg-accent-soft text-link' }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', cls)}>{children}</span>;
}
