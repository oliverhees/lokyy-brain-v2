import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api as defaultApi, type Api } from './api.ts';

export const ApiContext = createContext<Api>(defaultApi);
export const useApi = (): Api => useContext(ApiContext);

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** increases with every completed successful load (to tell fresh data from older data) */
  version: number;
  reload: () => void;
}

/** Loads data on mount; exposes loading / error / reload for the Loading/Empty/Error states. */
export function useLoad<T>(load: (api: Api) => Promise<T>): Loaded<T> {
  const api = useApi();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean; version: number }>({ data: null, error: null, loading: true, version: 0 });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load(api).then((data) => { if (live) setState((s) => ({ data, error: null, loading: false, version: s.version + 1 })); },
      (error: unknown) => { if (live) setState((s) => ({ ...s, data: null, error, loading: false })); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, n]);
  return { ...state, reload };
}

/** Calls fn every ms while active (e.g. to follow provisioning that another service performs). */
export function usePolling(active: boolean, ms: number, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
