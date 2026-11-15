'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { routeLabel } from '@/lib/monitor-labels';
import { fieldLabel } from '@/lib/ui';
import type { SessionDetail } from '@/types/observability';

const CARD = 'bg-[var(--card)] rounded-card border border-[var(--border)]';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

function SummaryField({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className={fieldLabel}>{label}</dt>
      <dd className={`mt-0.5 text-label truncate ${warn ? 'font-medium text-[var(--gold)]' : 'text-[var(--text)]'}`}>
        {value ?? <span className="text-[var(--muted2)]">—</span>}
      </dd>
    </div>
  );
}

export default function SessionDetailPage({ params }: { params: { sessionId: string } }) {
  const router = useRouter();
  const { sessionId } = params;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setDetail(await observabilityApi.getSession(sessionId)); setError(null); }
    catch (err) { setError(err instanceof ObservabilityApiError ? err.message : 'Failed to load session.'); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="max-w-[1180px]">
        <div className="h-28 rounded-card bg-[var(--surface)] animate-pulse mb-6" aria-hidden="true" />
        <div className="h-64 rounded-card bg-[var(--surface)] animate-pulse" aria-hidden="true" />
      </div>
    );
  }

  // No "Back to Sessions" button in either state: the hero draws a breadcrumb
  // and one page should not carry two ways to go back up.
  const hero = (
    <AdminPageHero
      title="Session"
      subtitle={sessionId}
      parent={{ label: 'Sessions', href: '/admin/rag-traces/sessions' }}
    />
  );

  if (error || !detail) {
    return (
      <div className="max-w-[1180px]">
        {hero}
        <div className={CARD}><ErrorState message={error ?? 'Session not found.'} onRetry={load} /></div>
      </div>
    );
  }

  const { summary, turns } = detail;
  const errorCount = summary.errorCount ?? 0;

  return (
    <div className="max-w-[1180px]">
      {hero}

      {/* Four across, not six. There are seven fields, so a six-wide grid put
          six on the first row and left the seventh alone with five empty
          columns beside it. Four gives rows of four and three. */}
      <dl className={`${CARD} p-6 mb-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-5`}>
        <SummaryField label="Requests" value={summary.traceCount} />
        {/* The sum of how long each request took, not the time from the first
            to the last. A conversation spread over an hour can hold a minute
            of answering, so the label says total rather than leaving the
            reader to read it as elapsed time. */}
        <SummaryField label="Total answer time" value={fmtMs(summary.totalDurationMs)} />
        <SummaryField label="Tokens used" value={summary.totalTokens?.toLocaleString() ?? null} />
        <SummaryField label="Answered" value={summary.successCount ?? null} />
        <SummaryField label="Failed" value={summary.errorCount ?? null} warn={errorCount > 0} />
        <SummaryField
          label="Question types"
          value={summary.routes?.length ? summary.routes.map(routeLabel).join(', ') : null}
        />
        {/* Which lecture the conversation was about. The grouped query already
            returns it; nothing was showing it. Kept off the list, which has
            seven columns already, and put here where there is room. */}
        <SummaryField
          label={summary.lectureIds && summary.lectureIds.length > 1 ? 'Lectures' : 'Lecture'}
          value={summary.lectureIds?.length ? summary.lectureIds.join(', ') : null}
        />
      </dl>

      <div className={CARD}>
        <div className="px-6 pt-5 pb-3">
          <h2 className="text-label font-semibold text-[var(--text)]">Conversation turns</h2>
          <p className="text-caption text-[var(--muted2)] mt-0.5">In the order they were asked. Select one to open its request.</p>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {turns.length === 0 ? (
            <p className="text-caption text-[var(--muted2)] px-6 pb-6">No turns recorded.</p>
          ) : turns.map((t, i) => (
            <button
              key={t.traceId}
              onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}?from=session`)}
              className="w-full text-left px-6 py-4 hover:bg-[var(--surface)] transition-colors flex items-start gap-4"
            >
              <span className="w-6 h-6 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-semibold flex items-center justify-center text-[11px] shrink-0 mt-0.5">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 text-caption">
                  <TraceStatusBadge status={t.status} />
                  <span className="text-[var(--muted)]">{routeLabel(t.route)}</span>
                  <span className="text-[var(--muted2)] tabular-nums ml-auto">{fmtMs(t.durationMs)}</span>
                </div>
                {t.input && <p className="text-caption text-[var(--text)] truncate"><span className="font-medium">Asked:</span> {t.input}</p>}
                {t.output && <p className="text-caption text-[var(--muted)] truncate mt-0.5"><span className="font-medium">Answered:</span> {t.output}</p>}
                {!t.input && !t.output && (
                  <p className="text-caption text-[var(--muted2)]">The question and answer text was not recorded.</p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
