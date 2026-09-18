import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { de } from '../shared/i18n/de.ts';
import { errorMessage } from './api.ts';
import { useLoad } from './context.tsx';
import type { Session } from './types.ts';
import { LoadError, Loading } from './components/ui.tsx';
import { AuditPage } from './pages/AuditPage.tsx';
import { MePage } from './pages/MePage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';

type Route = 'setup' | 'users' | 'audit' | 'me';
const ADMIN_ROUTES: Route[] = ['setup', 'users', 'audit'];

function useHashRoute(): [Route | null, (r: Route) => void] {
  const read = () => (window.location.hash.replace(/^#\//, '') || null) as Route | null;
  const [route, setRoute] = useState<Route | null>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => { window.location.hash = `#/${r}`; setRoute(r); }];
}

export function App() {
  const { data: session, error, loading, reload } = useLoad(async (a) => {
    const s = await a.get<Session>('/api/session');
    a.setCsrf(s.csrfToken);
    return s;
  });
  const [hashRoute, navigate] = useHashRoute();

  useEffect(() => { document.title = de.app.title; }, []);

  if (loading && !session) return <div className="mx-auto max-w-5xl p-6"><Loading /></div>;
  if (error || !session) return <div className="mx-auto max-w-5xl p-6"><LoadError message={errorMessage(error)} onRetry={reload} /></div>;

  const allowed: Route[] = session.isAdmin ? [...ADMIN_ROUTES, ...(session.hasAccess ? ['me' as const] : [])] : ['me'];
  const fallback: Route = session.isAdmin ? (session.setupComplete ? 'users' : 'setup') : 'me';
  const route = hashRoute && allowed.includes(hashRoute) ? hashRoute : fallback;
  const labels: Record<Route, string> = de.app.nav;

  return (
    <div className="min-h-screen bg-canvas">
      <a href="#main" className="focus-ring sr-only rounded-md bg-surface px-3 py-2 text-sm font-semibold text-link focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50">
        {de.app.skipToContent}
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <Brain aria-hidden className="h-6 w-6 text-link" />
            <span className="text-base font-semibold text-fg">Lokyy Brain</span>
            {session.companyName && <span className="text-sm text-muted">· {session.companyName}</span>}
            {session.package && <span className="text-sm text-muted">· {de.app.package(session.package)}</span>}
          </div>
          <span className="text-sm text-muted">{de.app.signedInAs(session.username)}</span>
        </div>
        {allowed.length > 1 && (
          <nav aria-label={de.app.navLabel} className="mx-auto max-w-5xl px-2 sm:px-4">
            <ul className="flex flex-wrap gap-1">
              {allowed.map((r) => (
                <li key={r}>
                  <a href={`#/${r}`} aria-current={r === route ? 'page' : undefined}
                    onClick={(e) => { e.preventDefault(); navigate(r); }}
                    className={`focus-ring inline-flex min-h-[40px] items-center border-b-2 px-3 text-sm font-medium ${r === route ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
                    {labels[r]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 outline-none sm:px-6">
        {route === 'setup' && <SetupPage onDone={() => { reload(); navigate('users'); }} />}
        {route === 'users' && <UsersPage />}
        {route === 'audit' && <AuditPage />}
        {route === 'me' && <MePage />}
      </main>
    </div>
  );
}
