import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api as defaultApi, type Api } from './api.ts';

export const ApiContext = createContext<Api>(defaultApi);
export const useApi = (): Api => useContext(ApiContext);

/** Loads data on mount; exposes loading / error / reload for the Loading/Empty/Error states. */
export function useLoad<T>(load: (api: Api) => Promise<T>): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const api = useApi();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load(api).then((data) => { if (live) setState({ data, error: null, loading: false }); },
      (error: unknown) => { if (live) setState({ data: null, error, loading: false }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, n]);
  return { ...state, reload };
}
