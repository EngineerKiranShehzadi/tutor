'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { MetricCard } from '@/components/observability/MetricCard';
import { PhoenixUnavailablePanel, EmptyState } from '@/components/observability/PhoenixConnectionState';
import { useAutoRefresh } from '@/components/observability/useAutoRefresh';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { OverviewMetrics, ObservabilityStatus, MetricResult } from '@/types/observability';

const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
const CHART_TOOLTIP_STYLE = { borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13, color: '#334155', padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' };

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// Turns a backend MetricResult<number> into the MetricCard props that
// render its three states distinctly: a real measured value (incl. 0), a
// fetched-but-nothing-to-measure state (value:null, available:true — the
// backend's `unavailableReason` already carries the right copy, e.g. "No
// memory lookups in this period" / "No traces in this period"), or a
// genuinely-unavailable state (value:null, available:false — Phoenix
// unreachable, enrichment unsupported/failed, or every enriched trace
// lacked telemetry this metric requires).
//
// The disclosure note under the value keeps three distinct reasons separate
// rather than collapsing them into one generic "sampled" label:
//   - sampled:  only the most recent `sampleSize` traces were fetched at all
//   - partial:  some of those fetched traces lacked the telemetry this
//               specific metric needs (legacy/incomplete instrumentation)
//               and were excluded from `value`, not counted as a negative
//   - both:     shown together, sampling first then the coverage caveat
function metricResultProps(m: MetricResult<number> | undefined, format: (n: number) => string = (n) => n.toLocaleString()) {
  if (!m) return { value: null as string | number | null };
  let sampleNote: string | undefined;
  if (m.partial && m.eligibleSampleSize !== undefined && m.incompleteSampleSize !== undefined) {
    const elig = m.eligibleSampleSize, inc = m.incompleteSampleSize;
    sampleNote = `Based on ${elig} compatible trace${elig === 1 ? '' : 's'}; ${inc} older trace${inc === 1 ? '' : 's'} excluded`;
    if (m.sampled) sampleNote += ` (sampled from the most recent ${m.sampleSize})`;
  } else if (m.sampled) {
    sampleNote = `Based on the most recent ${m.sampleSize} requests`;
  }
  return {
    value: m.value === null ? null : format(m.value),
    available: m.available,
    unavailableReason: m.unavailableReason,
    emptyMessage: m.unavailableReason,
    sampleNote,
  };
}

function ChartCard({ title, subtitle, icon, children, empty, unavailable }: { title: string; subtitle: string; icon: string; children: React.ReactNode; empty?: boolean; unavailable?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">{title}</h2>
          <p className="text-[12px] text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <i className={`${icon} text-indigo-500 text-[12px]`} />
        </div>
      </div>
      {unavailable ? (
        <div className="py-14 px-6 text-center">
          <i className="fas fa-circle-info text-slate-300 text-[22px] mb-3" />
          <p className="text-[13px] font-semibold text-slate-500">Unavailable</p>
          <p className="text-[12px] text-slate-400 mt-1 max-w-[320px] mx-auto">{unavailable}</p>
        </div>
      ) : empty ? (
        <div className="py-14"><EmptyState icon="fa-chart-simple" title="No data in range" message="Try a wider time range or ask a lecture question to generate traces." /></div>
      ) : children}
    </div>
  );
}

export default function ObservabilityOverviewPage() {
  const router = useRouter();
  const [status, setStatus] = useState<ObservabilityStatus | null>(null);
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, o] = await Promise.all([
        observabilityApi.getStatus(signal),
        observabilityApi.getOverview({}, signal),
      ]);
      setStatus(s);
      setMetrics(o.metrics);
      setError(null);
      setErrorCode(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) { setError(err.message); setErrorCode(err.code); }
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') { setError('Unexpected error loading the overview.'); setErrorCode(null); }
    } finally {
      setLoading(false);
    }
  }, []);

  const { autoRefresh, setAutoRefresh, refresh, lastRefreshedAt, setLastRefreshedAt } = useAutoRefresh(() => load());

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setLastRefreshedAt(new Date()));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unavailable = errorCode === 'PHOENIX_DISABLED' || errorCode === 'PHOENIX_UNREACHABLE';

  return (
    <div className="max-w-[1500px]">
      <ObservabilityHeader
        subtitle="Live RAG pipeline monitoring — sourced from Phoenix, rendered in our own admin theme."
        onRefresh={refresh}
        refreshing={loading}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        lastRefreshedAt={lastRefreshedAt}
      />
      <ObservabilityTabs />

      {unavailable ? (
        <PhoenixUnavailablePanel status={status} />
      ) : error ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 flex flex-col items-center text-center px-8">
          <i className="fas fa-triangle-exclamation text-2xl text-red-400 mb-3" />
          <p className="text-[15px] font-semibold text-slate-700">Could not load overview</p>
          <p className="text-[13px] text-slate-400 mt-1">{error}</p>
        </div>
      ) : (
        <>
          {metrics && metrics.telemetryCoverage.legacyOrIncompleteTraces > 0 && (
            <p className="text-[12px] text-slate-400 mb-3">
              <i className="fas fa-circle-info mr-1.5" />
              {metrics.telemetryCoverage.eligibleTraces} of {metrics.telemetryCoverage.totalTraces} recently sampled traces carry full observability telemetry;
              {' '}{metrics.telemetryCoverage.legacyOrIncompleteTraces} older/incomplete trace{metrics.telemetryCoverage.legacyOrIncompleteTraces === 1 ? '' : 's'} {metrics.telemetryCoverage.legacyOrIncompleteTraces === 1 ? 'is' : 'are'} excluded from schema-gated metrics below rather than counted as a negative result.
            </p>
          )}
          {/* KPI cards */}
          <div className="grid grid-cols-4 gap-5 mb-6">
            <MetricCard loading={loading} label="Total requests" value={metrics ? metrics.totalTraces : null} tooltip="Count of root RAG traces in the selected range." icon="fas fa-inbox" accent="indigo" />
            <MetricCard loading={loading} label="Success rate" value={metrics ? `${(metrics.successRate * 100).toFixed(1)}%` : null} tooltip="Traces that completed without an ERROR status, divided by total traces." icon="fas fa-circle-check" accent="emerald" />
            <MetricCard loading={loading} label="Error rate" value={metrics ? `${(metrics.errorRate * 100).toFixed(1)}%` : null} tooltip="Traces with ERROR status, divided by total traces." icon="fas fa-circle-exclamation" accent="red" />
            <MetricCard loading={loading} label="Avg latency" value={metrics ? fmtMs(metrics.latencyMs.avg) : null} tooltip="Mean root-trace duration across all traces in range." icon="fas fa-gauge-high" accent="violet" />
            <MetricCard loading={loading} label="P95 latency" value={metrics ? fmtMs(metrics.latencyMs.p95) : null} tooltip="95th percentile root-trace duration — 95% of requests finished at or below this." icon="fas fa-stopwatch" accent="amber" />
            <MetricCard loading={loading} label="Total tokens" value={metrics ? metrics.tokens.total.toLocaleString() : null} tooltip="Cumulative prompt + completion tokens across every LLM span in range, as reported by Phoenix." icon="fas fa-coins" accent="cyan" />
            <MetricCard
              loading={loading}
              label="Memory hits"
              tooltip="FACT_QUESTION traces answered from cached answer-memory (exact or semantic match), from the same enriched sample used for route/model — see the sampling note below."
              icon="fas fa-brain"
              accent="violet"
              {...metricResultProps(metrics?.memory.hits)}
            />
            <MetricCard
              loading={loading}
              label="Memory misses"
              tooltip="FACT_QUESTION traces whose answer-memory lookup found nothing, so a fresh generation ran. Excludes lookup failures and requests where memory wasn't attempted."
              icon="fas fa-brain"
              accent="amber"
              {...metricResultProps(metrics?.memory.misses)}
            />
            <MetricCard
              loading={loading}
              label="Memory-hit rate"
              tooltip="Hits ÷ (hits + misses) among completed memory lookups only — lookup failures, disabled memory, and not-attempted requests are excluded from both sides of the ratio."
              icon="fas fa-percent"
              accent="violet"
              {...metricResultProps(metrics?.memory.hitRate, n => `${(n * 100).toFixed(0)}%`)}
            />
            <MetricCard
              loading={loading}
              label="Zero-retrieval count"
              tooltip={`Retrieval-attempting requests (vector search ran) where 0 candidates came back.${metrics?.zeroRetrievalCount.available && metrics.zeroRetrievalCount.value !== null ? ` ${metrics.zeroRetrievalCount.attemptedCount} request(s) attempted retrieval in this sample.` : ' Routes that skip retrieval (greetings, lecture summaries) are excluded.'}`}
              icon="fas fa-magnifying-glass-minus"
              accent="red"
              {...metricResultProps(metrics?.zeroRetrievalCount)}
            />
            <MetricCard
              loading={loading}
              label="Fallback count"
              tooltip="Requests that returned a hardcoded not-found answer or hit a classified retrieval/generation failure, instead of a fresh grounded answer."
              icon="fas fa-life-ring"
              accent="red"
              {...metricResultProps(metrics?.fallbackCount)}
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-2 gap-5 mb-5">
            <ChartCard title="Requests over time" subtitle="Traces per bucket" icon="fas fa-chart-area" empty={!loading && (metrics?.timeSeries.length ?? 0) === 0}>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={metrics?.timeSeries ?? []} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="reqFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => new Date(v).toLocaleString()} />
                  <Area type="monotone" dataKey="requestCount" name="Requests" stroke="#6366f1" strokeWidth={2} fill="url(#reqFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Latency over time" subtitle="Average vs P95, per bucket" icon="fas fa-gauge-high" empty={!loading && (metrics?.timeSeries.length ?? 0) === 0}>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={metrics?.timeSeries ?? []} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}ms`} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => new Date(v).toLocaleString()} formatter={(v) => `${Math.round(Number(v))}ms`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="avgLatencyMs" name="Avg" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="p95LatencyMs" name="P95" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Token usage over time" subtitle="Prompt vs completion, per bucket" icon="fas fa-coins" empty={!loading && (metrics?.timeSeries.length ?? 0) === 0}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics?.timeSeries ?? []} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => new Date(v).toLocaleString()} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="promptTokens" name="Prompt" stackId="tok" fill="#6366f1" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="completionTokens" name="Completion" stackId="tok" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Success vs errors over time" subtitle="Per bucket" icon="fas fa-check-double" empty={!loading && (metrics?.timeSeries.length ?? 0) === 0}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics?.timeSeries ?? []} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => new Date(v).toLocaleString()} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="successCount" name="Success" stackId="s" fill="#10b981" />
                  <Bar dataKey="errorCount" name="Error" stackId="s" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid grid-cols-3 gap-5 mb-5">
            <ChartCard
              title="Route distribution"
              subtitle={metrics?.routeDistribution.sampled ? `Most recent ${metrics.routeDistribution.sampleSize} requests (sampled)` : 'Where requests were classified'}
              icon="fas fa-signs-post"
              unavailable={metrics && !metrics.routeDistribution.available ? metrics.routeDistribution.unavailableReason ?? 'Unavailable' : undefined}
              empty={!loading && Object.keys(metrics?.routeDistribution.data ?? {}).length === 0}
            >
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.routeDistribution.data ?? {}).map(([name, value]) => ({ name, value }))} layout="vertical" margin={{ top: 8, right: 20, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} onClick={(d) => router.push(`/admin/rag-traces/traces?route=${encodeURIComponent(String((d as { name: string }).name))}`)} cursor="pointer">
                    {Object.keys(metrics?.routeDistribution.data ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Span-kind distribution" subtitle="OpenInference span kinds in range" icon="fas fa-layer-group" empty={!loading && Object.keys(metrics?.spanKindDistribution ?? {}).length === 0}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.spanKindDistribution ?? {}).map(([name, value]) => ({ name, value }))} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {Object.keys(metrics?.spanKindDistribution ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Model usage"
              subtitle={metrics?.modelDistribution.sampled ? `Most recent ${metrics.modelDistribution.sampleSize} requests (sampled)` : 'LLM span calls by model'}
              icon="fas fa-robot"
              unavailable={metrics && !metrics.modelDistribution.available ? metrics.modelDistribution.unavailableReason ?? 'Unavailable' : undefined}
              empty={!loading && Object.keys(metrics?.modelDistribution.data ?? {}).length === 0}
            >
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.modelDistribution.data ?? {}).map(([name, value]) => ({ name, value }))} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {Object.keys(metrics?.modelDistribution.data ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
              <div className="px-6 pt-5 pb-3"><h2 className="text-[15px] font-bold text-slate-900">Slowest pipeline stages</h2><p className="text-[12px] text-slate-400 mt-0.5">Average duration by span name</p></div>
              {(metrics?.slowestOperations.length ?? 0) === 0 ? <EmptyState icon="fa-stopwatch" title="No spans yet" message="Slow-span data will appear once traces exist." /> : (
                <div className="divide-y divide-slate-50 pb-2">
                  {metrics!.slowestOperations.map(op => (
                    <div key={op.name} className="flex items-center gap-3 px-6 py-2.5">
                      <span className="flex-1 text-[13px] font-medium text-slate-700 truncate">{op.name}</span>
                      <span className="text-[12px] text-slate-400">{op.count}×</span>
                      <span className="text-[13px] font-bold text-slate-700 tabular-nums w-16 text-right">{fmtMs(op.avgDurationMs)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
              <div className="px-6 pt-5 pb-3"><h2 className="text-[15px] font-bold text-slate-900">Most common errors</h2><p className="text-[12px] text-slate-400 mt-0.5">Click to filter the Traces tab</p></div>
              {(metrics?.mostFrequentErrors.length ?? 0) === 0 ? <EmptyState icon="fa-face-smile" title="No errors in range" message="Nothing to show — that's a good sign." /> : (
                <div className="divide-y divide-slate-50 pb-2">
                  {metrics!.mostFrequentErrors.map(e => (
                    <button key={e.errorCode} onClick={() => router.push(`/admin/rag-traces/errors?code=${encodeURIComponent(e.errorCode)}`)} className="w-full flex items-center gap-3 px-6 py-2.5 hover:bg-slate-50 transition-colors text-left">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                      <span className="flex-1 text-[13px] font-mono text-slate-700 truncate">{e.errorCode}</span>
                      <span className="text-[13px] font-bold text-red-600 tabular-nums">{e.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
