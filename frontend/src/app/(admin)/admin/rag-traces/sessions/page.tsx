'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { CursorPagination } from '@/components/observability/Pagination';
import { EmptyState, ErrorState, PhoenixUnavailablePanel } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { fmtDateTime } from '@/lib/chart-format';
import { routeLabel } from '@/lib/monitor-labels';
import type { SessionSummary } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

export default function SessionsListPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await observabilityApi.listSessions({ cursor, limit: 25 }, signal);
      setSessions(result.sessions);
      setNextCursor(result.nextCursor);
      setError(null); setErrorCode(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) { setError(err.message); setErrorCode(err.code); }
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') setError('Failed to load sessions.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(cursorStack[pageIndex] ?? null, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  const goNext = () => { if (!nextCursor) return; setCursorStack(s => [...s.slice(0, pageIndex + 1), nextCursor]); setPageIndex(i => i + 1); };
  const goPrev = () => { if (pageIndex > 0) setPageIndex(i => i - 1); };
  const unsupported = errorCode === 'PHOENIX_UNSUPPORTED_FEATURE';

  return (
    <div className="max-w-[1180px]">
      <ObservabilityHeader title="Sessions" subtitle="Requests grouped into the conversation they belong to." />
      <ObservabilityTabs />

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        {unsupported ? (
          <EmptyState title="Sessions unsupported by this Phoenix server" message="This capability requires a newer Phoenix server version. Check the System Health tab for details." />
        ) : errorCode === 'PHOENIX_DISABLED' || errorCode === 'PHOENIX_UNREACHABLE' ? (
          <PhoenixUnavailablePanel status={null} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(cursorStack[pageIndex] ?? null)} />
        ) : loading ? (
          <div className="p-6 space-y-3">{[1, 2, 3, 4].map(i => <div key={i} className="h-14 bg-[var(--surface)] rounded-control animate-pulse" />)}</div>
        ) : sessions.length === 0 ? (
          <EmptyState title="No sessions yet" message="Sessions appear once students start multi-turn conversations with the tutor." />
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                  <th className="px-5 py-3 font-medium">Session</th>
                  <th className="px-4 py-3 font-medium">First activity</th>
                  <th className="px-4 py-3 font-medium">Last activity</th>
                  <th className="px-4 py-3 font-medium">Requests</th>
                  <th className="px-4 py-3 font-medium">Failed</th>
                  <th className="px-4 py-3 font-medium">Total answer time</th>
                  <th className="px-4 py-3 font-medium">Question types</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {sessions.map(s => (
                  <tr key={s.sessionId} onClick={() => router.push(`/admin/rag-traces/sessions/${encodeURIComponent(s.sessionId)}`)} className="hover:bg-[var(--surface)] cursor-pointer transition-colors">
                    <td className="px-5 py-3.5 text-caption text-[var(--text)]">{s.sessionId}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--text)]">{fmtDateTime(s.firstActivity)}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--text)]">{fmtDateTime(s.lastActivity)}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--text)] tabular-nums">{s.traceCount}</td>
                    <td className={`px-4 py-3.5 text-caption tabular-nums ${s.errorCount ? 'font-medium text-[var(--gold)]' : 'text-[var(--text)]'}`}>
                      {s.errorCount ?? '—'}
                    </td>
                    <td className="px-4 py-3.5 text-caption text-[var(--text)] tabular-nums">{fmtMs(s.totalDurationMs)}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--text)]">
                      {s.routes?.length ? s.routes.map(routeLabel).join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {/* Outside the card: inside it, this had a table row's width,
          padding and top rule, so it read as one more row. */}
      {!error && !loading && sessions.length > 0 && (
        <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${sessions.length} session${sessions.length !== 1 ? 's' : ''} on this page`} />
      )}
    </div>
  );
}
