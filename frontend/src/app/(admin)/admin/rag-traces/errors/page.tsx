'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { Figures, type Figure } from '@/components/monitor/Figures';
import { EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { bucketTickFormatter, fmtDateTime } from '@/lib/chart-format';
import { routeLabel } from '@/lib/monitor-labels';
import type { OverviewMetrics, TraceSummary } from '@/types/observability';

// Tighter than before, and sat closer to the bar: the old padding pushed the
// box well clear of whatever was being hovered.
const CHART_TOOLTIP_STYLE = { borderRadius: 10, border: '1px solid #e5e3df', fontSize: 12, color: '#1c1f24', padding: '7px 10px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' };
// No hover band behind the bar. Recharts draws it across the whole category
// slot and the full height of the plot, so on a near-flat bar it became a tall
// empty grey rectangle. The tooltip's first line already names the bar it
// belongs to, which is what the band was there to do.
function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

function errorFigures(m: OverviewMetrics | null): Figure[] {
  if (!m) return [
    { label: 'Requests checked', value: null },
    { label: 'Failed', value: null },
    { label: 'Failure rate', value: null },
    { label: 'Error codes', value: null },
  ];
  return [
    { label: 'Requests checked', value: m.totalTraces.toLocaleString() },
    { label: 'Failed', value: m.failedTraces.toLocaleString(), warn: m.failedTraces > 0 },
    { label: 'Failure rate', value: `${(m.errorRate * 100).toFixed(1)}%`, warn: m.failedTraces > 0 },
    {
      label: 'Error codes',
      value: String(m.mostFrequentErrors.length),
      note: m.mostFrequentErrors.length > 0 ? 'distinct kinds of failure' : undefined,
    },
  ];
}

export default function ErrorsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusCode = searchParams.get('code');

  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [failedTraces, setFailedTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      // Sequenced on purpose. The counts cover the most recent 500
      // requests (OVERVIEW_TRACE_LIMIT), and the failure list used to have no
      // window at all, so it returned the newest failures of ALL time. The
      // page then read "5 errors, 2 codes" above a table of fourteen
      // failures and a third code. The overview's range is fetched first and
      // handed to the list, so both describe the same requests.
      const o = await observabilityApi.getOverview({}, signal);
      const t = await observabilityApi.listTraces({
        errorOnly: true,
        errorCode: focusCode ?? undefined,
        startTime: o.metrics.range.startTime,
        endTime: o.metrics.range.endTime,
        limit: 25, sort: 'start_time', order: 'desc',
      }, signal);
      setMetrics(o.metrics);
      setFailedTraces(t.traces);
      setError(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) setError(err.message);
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') setError('Failed to load error analytics.');
    } finally { setLoading(false); }
  }, [focusCode]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="max-w-[1180px]">
      <ObservabilityHeader title="Errors" subtitle="Only the requests that failed, and what they failed on." onRefresh={() => load()} refreshing={loading} />
      <ObservabilityTabs />

      {error ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)]"><ErrorState message={error} onRetry={() => load()} /></div>
      ) : (
        <>
          {/* The same figure row Tutor Health and the Overview use, rather
              than a grid of four tinted cards.
              "LLM calls" was dropped: it counted model calls in the period,
              which is not a fact about failure and belongs on the Overview.
              "Requests checked" took its place, because without it nothing on
              the page said what the percentage was a percentage of. */}
          <div className="mb-6">
            <Figures loading={loading} items={errorFigures(metrics)} />
          </div>

          <div className="grid grid-cols-2 gap-5 mb-6">
            <div className="bg-[var(--card)] rounded-card border border-[var(--border)]">
              <div className="px-6 pt-5 pb-3"><h2 className="text-label font-semibold text-[var(--text)]">Errors over time</h2></div>
              {(metrics?.timeSeries.length ?? 0) === 0 ? <EmptyState title="No errors" message="No request failed in this period." /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={metrics!.timeSeries} margin={{ top: 8, right: 20, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" vertical={false} />
                    <XAxis dataKey="bucket" tickFormatter={bucketTickFormatter(metrics!.timeSeries)} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} width={46} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={false} offset={8} contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => fmtDateTime(String(v))} />
                    <Bar dataKey="errorCount" name="Errors" fill="#a35f0d" maxBarSize={56} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="bg-[var(--card)] rounded-card border border-[var(--border)]">
              <div className="px-6 pt-5 pb-3"><h2 className="text-label font-semibold text-[var(--text)]">Errors by code</h2><p className="text-caption text-[var(--muted2)] mt-0.5">Click to filter the trace list below</p></div>
              {(metrics?.mostFrequentErrors.length ?? 0) === 0 ? <EmptyState title="No errors" message="No failure codes recorded in this period." /> : (
                <div className="divide-y divide-[var(--border)] pb-2">
                  {metrics!.mostFrequentErrors.map(e => (
                    <button key={e.errorCode} onClick={() => router.push(`/admin/rag-traces/errors?code=${encodeURIComponent(e.errorCode)}`)} className={`group w-full flex items-center gap-3 px-6 py-2.5 hover:bg-[var(--surface)] transition-colors text-left ${focusCode === e.errorCode ? 'bg-[var(--gold-soft)]' : ''}`}>
                      <span className="flex-1 text-caption font-mono text-[var(--text)]">{e.errorCode}</span>
                      <span className="text-caption font-semibold text-[var(--gold)] tabular-nums">{e.count}</span>
                      <i className="fas fa-chevron-right text-[11px] text-[var(--muted2)] group-hover:text-[var(--accent)] transition-colors" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
            <div className="px-6 pt-5 pb-3 flex items-center justify-between">
              <div><h2 className="text-label font-semibold text-[var(--text)]">Recent failed traces</h2><p className="text-caption text-[var(--muted2)] mt-0.5">{focusCode ? `Filtered to ${focusCode}` : 'All error codes'}</p></div>
              {focusCode && <button onClick={() => router.push('/admin/rag-traces/errors')} className="text-caption font-semibold text-[var(--muted)] hover:text-[var(--gold)]"><i className="fas fa-xmark mr-1" />Clear filter</button>}
            </div>
            {loading ? <div className="p-6 space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-10 bg-[var(--surface)] rounded-control animate-pulse" />)}</div>
              : failedTraces.length === 0 ? (
                <EmptyState
                  title={focusCode ? `No ${focusCode} failures` : 'No failures'}
                  message={`Nothing failed among the ${(metrics?.totalTraces ?? 0).toLocaleString()} requests checked.`}
                />)
              : (
                <table className="w-full">
                  <thead><tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                    <th className="px-5 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Route</th>
                    <th className="px-4 py-3 font-medium">Error</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Trace</th>
                  </tr></thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {failedTraces.map(t => (
                      <tr key={t.traceId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}?from=errors`)} className="hover:bg-[var(--surface)] cursor-pointer transition-colors">
                        <td className="px-5 py-3 text-caption text-[var(--text)]">{fmtDateTime(t.timestamp)}</td>
                        <td className="px-4 py-3 text-caption text-[var(--text)]">{routeLabel(t.route)}</td>
                        {/* No status badge: every row here failed, so a column of the word
                            "Error" beside the code added nothing. */}
                        <td className="px-4 py-3 text-caption font-mono text-[var(--gold)]">{t.errorCode ?? '—'}</td>
                        <td className="px-4 py-3 text-caption text-[var(--text)] tabular-nums">{fmtMs(t.durationMs)}</td>
                        <td className="px-4 py-3 text-[11px] text-[var(--muted2)] font-mono truncate max-w-[140px]">{t.traceId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </>
      )}
    </div>
  );
}
