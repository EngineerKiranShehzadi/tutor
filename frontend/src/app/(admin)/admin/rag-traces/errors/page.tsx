'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { MetricCard } from '@/components/observability/MetricCard';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { OverviewMetrics, TraceSummary } from '@/types/observability';

const CHART_TOOLTIP_STYLE = { borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13, color: '#334155', padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' };
function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

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
      const [o, t] = await Promise.all([
        observabilityApi.getOverview({}, signal),
        observabilityApi.listTraces({ errorOnly: true, limit: 25, sort: 'start_time', order: 'desc' }, signal),
      ]);
      setMetrics(o.metrics);
      setFailedTraces(t.traces);
      setError(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) setError(err.message);
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') setError('Failed to load error analytics.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const displayedTraces = focusCode ? failedTraces.filter(t => t.errorCode === focusCode) : failedTraces;

  return (
    <div className="max-w-[1500px]">
      <ObservabilityHeader subtitle="Focused error analysis across the RAG pipeline." onRefresh={() => load()} refreshing={loading} />
      <ObservabilityTabs />

      {error ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm"><ErrorState message={error} onRetry={() => load()} /></div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-5 mb-6">
            <MetricCard loading={loading} label="Total errors" value={metrics ? metrics.failedTraces : null} tooltip="Count of ERROR-status traces in range." icon="fas fa-bug" accent="red" />
            <MetricCard loading={loading} label="Error rate" value={metrics ? `${(metrics.errorRate * 100).toFixed(1)}%` : null} tooltip="Failed traces / total traces." icon="fas fa-percent" accent="red" />
            <MetricCard loading={loading} label="Distinct error codes" value={metrics ? metrics.mostFrequentErrors.length : null} tooltip="Number of distinct safe error codes observed (see tracer.ts classifyErrorCode)." icon="fas fa-list-ul" accent="amber" />
            <MetricCard loading={loading} label="LLM calls" value={metrics ? metrics.llmCallCount : null} tooltip="Total LLM spans in range, for context on error rate relative to volume." icon="fas fa-brain" accent="violet" />
          </div>

          <div className="grid grid-cols-2 gap-5 mb-6">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
              <div className="px-6 pt-5 pb-3"><h2 className="text-[15px] font-bold text-slate-900">Errors over time</h2></div>
              {(metrics?.timeSeries.length ?? 0) === 0 ? <EmptyState icon="fa-face-smile" title="No errors" message="Nothing to plot — good sign." /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={metrics!.timeSeries} margin={{ top: 8, right: 20, left: -10, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => new Date(v).toLocaleString()} />
                    <Bar dataKey="errorCount" name="Errors" fill="#ef4444" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
              <div className="px-6 pt-5 pb-3"><h2 className="text-[15px] font-bold text-slate-900">Errors by code</h2><p className="text-[12px] text-slate-400 mt-0.5">Click to filter the trace list below</p></div>
              {(metrics?.mostFrequentErrors.length ?? 0) === 0 ? <EmptyState icon="fa-face-smile" title="No errors" message="Nothing to show." /> : (
                <div className="divide-y divide-slate-50 pb-2">
                  {metrics!.mostFrequentErrors.map(e => (
                    <button key={e.errorCode} onClick={() => router.push(`/admin/rag-traces/errors?code=${encodeURIComponent(e.errorCode)}`)} className={`w-full flex items-center gap-3 px-6 py-2.5 hover:bg-slate-50 transition-colors text-left ${focusCode === e.errorCode ? 'bg-red-50' : ''}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                      <span className="flex-1 text-[13px] font-mono text-slate-700">{e.errorCode}</span>
                      <span className="text-[13px] font-bold text-red-600">{e.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 pt-5 pb-3 flex items-center justify-between">
              <div><h2 className="text-[15px] font-bold text-slate-900">Recent failed traces</h2><p className="text-[12px] text-slate-400 mt-0.5">{focusCode ? `Filtered to ${focusCode}` : 'All error codes'}</p></div>
              {focusCode && <button onClick={() => router.push('/admin/rag-traces/errors')} className="text-[12px] font-semibold text-slate-500 hover:text-red-600"><i className="fas fa-xmark mr-1" />Clear filter</button>}
            </div>
            {loading ? <div className="p-6 space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
              : displayedTraces.length === 0 ? <EmptyState icon="fa-face-smile" title="No failed traces" message="Nothing to show for this filter." />
              : (
                <table className="w-full">
                  <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                    <th className="text-left px-5 py-3 text-[11px] font-semibold text-slate-500 uppercase">Time</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase">Route</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase">Error</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase">Duration</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase">Trace</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {displayedTraces.map(t => (
                      <tr key={t.traceId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}`)} className="hover:bg-slate-50/60 cursor-pointer transition-colors">
                        <td className="px-5 py-3 text-[12px] text-slate-500">{new Date(t.timestamp).toLocaleString()}</td>
                        <td className="px-4 py-3 text-[12px] font-medium text-slate-600">{t.route ?? '—'}</td>
                        <td className="px-4 py-3"><TraceStatusBadge status="ERROR" /> <span className="text-[11px] font-mono text-slate-500 ml-1">{t.errorCode}</span></td>
                        <td className="px-4 py-3 text-[13px] text-slate-500 tabular-nums">{fmtMs(t.durationMs)}</td>
                        <td className="px-4 py-3 text-[11px] text-slate-400 font-mono truncate max-w-[140px]">{t.traceId}</td>
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
