import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';
import { apiPost } from '../lib/api';
import type { EurouterRule } from '../lib/eurouter';

interface Props {
  provider: string;
  baseUrl: string;
  /** The key as shown in the form: a new key or the mask for the stored one. */
  apiKey: string;
  /** Selected rule id ('' = no route). */
  value: string;
  onChange: (ruleId: string) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rules: EurouterRule[] };

// Wait for typing to pause before sending a key to the server.
const KEY_DEBOUNCE_MS = 400;

const labelClass = 'text-[10.5px] tracking-[1px] uppercase font-semibold mb-1.5';
const hintClass = 'text-[11px] mt-1 leading-[1.45]';

/**
 * EUrouter "Route" picker (LBV2-30): lists the routing rules the key can use.
 * Shows the rule name, stores the rule id. EUrouter routes by rule, so the
 * route matters more than the model id.
 */
export function EurouterRoutePicker({ provider, baseUrl, apiKey, value, onChange }: Props) {
  const selectId = useId();
  const helpId = useId();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    const timer = setTimeout(() => {
      apiPost<{ rules: EurouterRule[] }>('/config/eurouter/rules', { provider, baseUrl, apiKey })
        .then((r) => { if (!cancelled) setState({ kind: 'ready', rules: r.rules }); })
        .catch((e: unknown) => { if (!cancelled) setState({ kind: 'error', message: (e as Error).message }); });
    }, attempt === 0 ? KEY_DEBOUNCE_MS : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [provider, baseUrl, apiKey, attempt]);

  let body: ReactElement;
  let hasSelect = false;
  if (!apiKey) {
    body = (
      <div data-testid="eurouter-routes-need-key" className={hintClass} style={{ color: 'var(--text-mid)' }}>
        Enter your EUrouter API key to load your routes.
      </div>
    );
  } else if (state.kind === 'loading') {
    body = (
      <div data-testid="eurouter-routes-loading" role="status" className={hintClass} style={{ color: 'var(--text-mid)' }}>
        Loading routes…
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div data-testid="eurouter-routes-error" role="alert" className="text-[11px] px-3 py-2 rounded-md flex items-center justify-between gap-3"
        style={{ background: 'var(--error-bg)', color: 'var(--error)' }}>
        <span>{state.message}</span>
        <button type="button" onClick={retry} className="text-[11px] font-semibold underline shrink-0" style={{ color: 'var(--error)' }}>
          Retry
        </button>
      </div>
    );
  } else if (state.rules.length === 0 && !value) {
    body = (
      <div data-testid="eurouter-routes-empty" className={hintClass} style={{ color: 'var(--text-mid)' }}>
        No routes found for this key. Create a routing rule in your EUrouter dashboard, or continue with a model only.
      </div>
    );
  } else {
    const selected = state.rules.find((r) => r.id.toLowerCase() === value.toLowerCase());
    const missing = value !== '' && !selected;
    hasSelect = true;
    body = (
      <>
        <select
          id={selectId}
          data-testid="eurouter-route-select"
          value={value}
          aria-describedby={helpId}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-[10px] px-3.5 py-3 text-[13px] outline-none glass-card transition-colors"
          style={{ color: 'var(--text-default)', background: 'var(--surface-1)' }}
        >
          <option value="">No route (model only)</option>
          {missing && <option value={value}>Saved route (not available for this key)</option>}
          {state.rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div id={helpId} data-testid="eurouter-route-help" className={hintClass} style={{ color: 'var(--text-mid)' }}>
          {selected
            ? <>The route filters and prioritizes providers for the model below.{selected.model && <> Its default model is <code>{selected.model}</code>.</>}</>
            : 'Without a route, EUrouter picks providers for the model below.'}
        </div>
      </>
    );
  }

  return (
    <div>
      {hasSelect
        ? <label htmlFor={selectId} className={labelClass} style={{ color: 'var(--text-mid)', display: 'block' }}>Route</label>
        : <div className={labelClass} style={{ color: 'var(--text-mid)' }}>Route</div>}
      {body}
    </div>
  );
}
