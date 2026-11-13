'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { CursorPagination } from '@/components/observability/Pagination';
import { EmptyState, ErrorState, PhoenixUnavailablePanel } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
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
      <ObservabilityHeader subtitle="Multi-turn conversations grouped by chat session — reconstructed from Phoenix session data." />
      <ObservabilityTabs />

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        {unsupported ? (
          <EmptyState icon="fa-comments" title="Sessions unsupported by this Phoenix server" message="This capability requires a newer Phoenix server version. Check the System Health tab for details." />
        ) : errorCode === 'PHOENIX_DISABLED' || errorCode === 'PHOENIX_UNREACHABLE' ? (
          <PhoenixUnavailablePanel status={null} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(cursorStack[pageIndex] ?? null)} />
        ) : loading ? (
          <div className="p-6 space-y-3">{[1, 2, 3, 4].map(i => <div key={i} className="h-14 bg-[var(--surface)] rounded-card animate-pulse" />)}</div>
        ) : sessions.length === 0 ? (
          <EmptyState icon="fa-comments" title="No sessions yet" message="Sessions appear once students start multi-turn conversations with the tutor." />
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface)]">
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-[var(--muted)]">Session</th>
                  <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-[var(--muted)]">First activity</th>
                  <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-[var(--muted)]">Last activity</th>
                  <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-[var(--muted)]">Traces</th>
                  <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-[var(--muted)]">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {sessions.map(s => (
                  <tr key={s.sessionId} onClick={() => router.push(`/admin/rag-traces/sessions/${encodeURIComponent(s.sessionId)}`)} className="hover:bg-[var(--surface)] cursor-pointer transition-colors">
                    <td className="px-5 py-3.5 text-caption font-mono text-[var(--text)]">{s.sessionId}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--muted)]">{new Date(s.firstActivity).toLocaleString()}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--muted)]">{new Date(s.lastActivity).toLocaleString()}</td>
                    <td className="px-4 py-3.5 text-caption font-semibold text-[var(--text)]">{s.traceCount}</td>
                    <td className="px-4 py-3.5 text-caption text-[var(--muted)] tabular-nums">{fmtMs(s.totalDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${sessions.length} session${sessions.length !== 1 ? 's' : ''} on this page`} />
          </>
        )}
      </div>
    </div>
  );
}
