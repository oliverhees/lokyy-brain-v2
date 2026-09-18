import { de } from '../../shared/i18n/de.ts';
import { errorMessage } from '../api.ts';
import { useLoad } from '../context.tsx';
import type { AuditEntry } from '../types.ts';
import { Card, LoadError, Loading } from '../components/ui.tsx';

const t = de.audit;
const fmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

export function AuditPage() {
  const { data, error, loading, reload } = useLoad((a) => a.get<{ entries: AuditEntry[] }>('/api/admin/audit'));
  if (loading && !data) return <Loading />;
  if (error && !data) return <LoadError message={errorMessage(error)} onRetry={reload} />;
  const entries = data!.entries;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-fg">{t.title}</h1>
        <p className="text-sm text-muted">{t.intro}</p>
      </header>
      {entries.length === 0 ? <Card><p className="py-6 text-center text-sm text-muted">{t.empty}</p></Card> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t.title}</caption>
            <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-fg">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">{t.when}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.who}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.what}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t.target}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="border-b border-line-soft last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-muted"><time dateTime={e.at}>{fmt.format(new Date(e.at))}</time></td>
                  <td className="px-4 py-2 text-fg">{e.actor}</td>
                  <td className="px-4 py-2 text-fg">{t.actions[e.action] ?? e.action}</td>
                  <td className="px-4 py-2 text-fg">{e.target ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
