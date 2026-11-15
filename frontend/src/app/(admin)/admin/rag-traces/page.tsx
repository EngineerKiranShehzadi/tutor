'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { Figures, type Figure } from '@/components/monitor/Figures';
import { PhoenixUnavailablePanel, EmptyState } from '@/components/observability/PhoenixConnectionState';
import { useAutoRefresh } from '@/components/observability/useAutoRefresh';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { fmtAxisNumber, bucketTickFormatter, fmtDateTime } from '@/lib/chart-format';
import type { OverviewMetrics, ObservabilityStatus } from '@/types/observability';

// Six tints of the two theme colours, so a chart with several series
// stays readable without introducing a third hue.
const COLORS = ['#1f3a5f', '#4a6b8a', '#8fb0d0', '#a35f0d', '#c2802f', '#8e8e92'];
// Tighter than before, and sat closer to the bar: the old padding pushed the
// box well clear of whatever was being hovered.
const CHART_TOOLTIP_STYLE = { borderRadius: 10, border: '1px solid #e5e3df', fontSize: 12, color: '#1c1f24', padding: '7px 10px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' };
// No hover band behind the bar. Recharts draws it across the whole category
// slot and the full height of the plot, so on a near-flat bar it became a tall
// empty grey rectangle. The tooltip's first line already names the bar it
// belongs to, which is what the band was there to do.

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}



// The headline figures.
//
// These were eleven cards in a grid, and several of them said the same thing
// more than once: success rate and error rate are one fact, and memory hits,
// memory misses and memory-hit rate are another. Three more repeated what
// Tutor Health already shows in plainer words, and zero-retrieval can no
// longer be measured at all, because the request log does not record how many
// candidates came back.
//
// What is left is five: how many requests, how many failed, how slow the worst
// of them were, what they cost in tokens, and how often an answer was reused.
// Drawn by the same component Tutor Health uses, so the two pages match.
function headlineFigures(m: OverviewMetrics | null): Figure[] {
  if (!m) return [
    { label: 'Requests', value: null },
    { label: 'Failed', value: null },
    { label: 'Slowest 5% took', value: null },
    { label: 'Tokens used', value: null },
    { label: 'Answered from memory', value: null },
  ];

  const hits = m.memory.hits.value;
  const misses = m.memory.misses.value;
  const lookups = hits !== null && misses !== null ? hits + misses : null;
  const hitRate = m.memory.hitRate.value;

  return [
    { label: 'Requests', value: m.totalTraces.toLocaleString() },
    {
      label: 'Failed',
      value: m.failedTraces.toLocaleString(),
      note: m.totalTraces > 0 ? `${(m.errorRate * 100).toFixed(1)}% of requests` : undefined,
      warn: m.failedTraces > 0,
    },
    {
      label: 'Slowest 5% took',
      value: fmtMs(m.latencyMs.p95),
      note: `typically ${fmtMs(m.latencyMs.median)}`,
    },
    {
      label: 'Tokens used',
      value: m.tokens.total.toLocaleString(),
      note: m.totalTraces > 0 ? `${Math.round(m.tokens.avgPerRequest).toLocaleString()} per request` : undefined,
    },
    {
      // The only figure in this row still read from a sample. Memory needs a
      // per-request field that does not aggregate the way the counts do, so it
      // covers the most recent requests rather than all of them. Standing
      // beside a true total, "122 of 428 lookups" reads as 428 out of every
      // request, so the note says which requests it actually looked at.
      label: 'Answered from memory',
      value: hitRate === null ? null : `${(hitRate * 100).toFixed(0)}%`,
      note: lookups && lookups > 0
        ? (m.memory.hitRate.sampled
            ? `${hits} of ${lookups} lookups in the last ${m.memory.hitRate.sampleSize.toLocaleString()} requests`
            : `${hits} of ${lookups} lookups`)
        : m.memory.hitRate.unavailableReason,
    },
  ];
}

// No icon tile beside the title: a tinted circle holding a decorative glyph
// repeated on every card added nothing the heading did not already say.
function ChartCard({ title, subtitle, children, empty, unavailable }: { title: string; subtitle: string; children: React.ReactNode; empty?: boolean; unavailable?: string }) {
  return (
    <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
      <div className="px-6 pt-5 pb-3">
        <h2 className="text-label font-semibold text-[var(--text)]">{title}</h2>
        <p className="text-caption text-[var(--muted2)] mt-0.5">{subtitle}</p>
      </div>
      {unavailable ? (
        <div className="py-14 px-6 text-center">
          <p className="text-caption font-semibold text-[var(--muted)]">Unavailable</p>
          <p className="text-caption text-[var(--muted2)] mt-1 max-w-[320px] mx-auto">{unavailable}</p>
        </div>
      ) : empty ? (
        <div className="py-14"><EmptyState title="No data in range" message="Try a wider time range or ask a lecture question to generate traces." /></div>
      ) : children}
    </div>
  );
}

// Remembered per browser, so the pointer to Tutor Health does not reappear
// on every visit once it has been read. Wrapped because storage throws in a
// private window, and the notice simply shows in that case.
const NOTICE_DISMISSED_KEY = 'askaitutor.observability.monitorNotice.dismissed';

export default function ObservabilityOverviewPage() {
  const router = useRouter();
  const [showNotice, setShowNotice] = useState(false);
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

  useEffect(() => {
    try { setShowNotice(localStorage.getItem(NOTICE_DISMISSED_KEY) !== '1'); }
    catch { setShowNotice(true); }
  }, []);

  const dismissNotice = () => {
    setShowNotice(false);
    try { localStorage.setItem(NOTICE_DISMISSED_KEY, '1'); } catch { /* private window */ }
  };

  const { autoRefresh, setAutoRefresh, refresh, lastRefreshedAt, setLastRefreshedAt } = useAutoRefresh(() => load());

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setLastRefreshedAt(new Date()));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unavailable = errorCode === 'PHOENIX_DISABLED' || errorCode === 'PHOENIX_UNREACHABLE';

  return (
    <div className="max-w-[1180px]">
      {showNotice && (
        <div className="mb-4 flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3 text-caption text-[var(--accent)]">
          <i className="fas fa-circle-info mt-0.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            For day-to-day monitoring use{' '}
            <Link href="/admin/monitor" className="font-semibold text-[var(--accent)] underline">Tutor Health</Link>.
            {' '}These pages show deep technical detail for engineers.
          </span>
          <button
            type="button"
            onClick={dismissNotice}
            aria-label="Dismiss this notice"
            className="-mr-1 -mt-0.5 shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-control text-[var(--accent)] hover:bg-[#dde6f0] transition-colors"
          >
            <i className="fas fa-xmark text-caption" aria-hidden="true" />
          </button>
        </div>
      )}
      <ObservabilityHeader
        title="Overview"
        subtitle="Request volume, token cost, and where time is spent inside each request."
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
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] py-16 flex flex-col items-center text-center px-8">
          <i className="fas fa-triangle-exclamation text-h1 text-[var(--gold)] mb-3" />
          <p className="text-label font-semibold text-[var(--text)]">Could not load overview</p>
          <p className="text-caption text-[var(--muted2)] mt-1">{error}</p>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <Figures loading={loading} items={headlineFigures(metrics)} />
            {metrics && metrics.telemetryCoverage.legacyOrIncompleteTraces > 0 && (
              <p className="text-caption text-[var(--muted2)] mt-3">
                {metrics.telemetryCoverage.legacyOrIncompleteTraces} of {metrics.telemetryCoverage.totalTraces} requests
                {' '}predate the current telemetry fields, so they are left out of the memory figure rather than counted as a miss.
              </p>
            )}
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-5 mb-5">
            {/* Requests over time, latency over time and success-vs-errors
                over time all lived here. Tutor Health draws the same three in
                plainer language, so this page kept a second copy for the same
                reader to compare against the first. What is left is what only
                the tracing data knows. */}
            <ChartCard title="Token usage over time" subtitle="Prompt vs completion, per bucket" empty={!loading && (metrics?.timeSeries.length ?? 0) === 0}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={metrics?.timeSeries ?? []} margin={{ top: 10, right: 20, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" vertical={false} />
                  <XAxis dataKey="bucket" tickFormatter={bucketTickFormatter(metrics?.timeSeries ?? [])} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} width={54} tickFormatter={fmtAxisNumber} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={false} offset={8} contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(v) => fmtDateTime(String(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="promptTokens" name="Prompt" stackId="tok" fill="#1f3a5f" maxBarSize={56} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="completionTokens" name="Completion" stackId="tok" fill="#8fb0d0" maxBarSize={56} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

          </div>

          <div className="grid grid-cols-3 gap-5 mb-5">
            <ChartCard
              title="Route distribution"
              subtitle={metrics?.routeDistribution.sampled ? `Most recent ${metrics.routeDistribution.sampleSize} requests (sampled)` : 'Where requests were classified'}
              unavailable={metrics && !metrics.routeDistribution.available ? metrics.routeDistribution.unavailableReason ?? 'Unavailable' : undefined}
              empty={!loading && Object.keys(metrics?.routeDistribution.data ?? {}).length === 0}
            >
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.routeDistribution.data ?? {}).map(([name, value]) => ({ name, value }))} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tickFormatter={fmtAxisNumber} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  {/* 110px clipped CONTEXTUAL_FOLLOW_UP to "EXTUAL_FOLLOW_UP". */}
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#5f6068' }} axisLine={false} tickLine={false} width={152} />
                  <Tooltip cursor={false} offset={8} contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" maxBarSize={26} radius={[0, 6, 6, 0]} onClick={(d) => router.push(`/admin/rag-traces/traces?route=${encodeURIComponent(String((d as { name: string }).name))}`)} cursor="pointer">
                    {Object.keys(metrics?.routeDistribution.data ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Operation types" subtitle="How many spans of each kind the tracing recorded" empty={!loading && Object.keys(metrics?.spanKindDistribution ?? {}).length === 0}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.spanKindDistribution ?? {}).map(([name, value]) => ({ name, value }))} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} width={46} tickFormatter={fmtAxisNumber} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={false} offset={8} contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" maxBarSize={56} radius={[6, 6, 0, 0]}>
                    {Object.keys(metrics?.spanKindDistribution ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Model usage"
              subtitle={metrics?.modelDistribution.sampled ? `Most recent ${metrics.modelDistribution.sampleSize} requests (sampled)` : 'LLM span calls by model'}
              unavailable={metrics && !metrics.modelDistribution.available ? metrics.modelDistribution.unavailableReason ?? 'Unavailable' : undefined}
              empty={!loading && Object.keys(metrics?.modelDistribution.data ?? {}).length === 0}
            >
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={Object.entries(metrics?.modelDistribution.data ?? {}).map(([name, value]) => ({ name, value }))} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} width={46} tickFormatter={fmtAxisNumber} tick={{ fontSize: 11, fill: '#8e8e92' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={false} offset={8} contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" maxBarSize={56} radius={[6, 6, 0, 0]}>
                    {Object.keys(metrics?.modelDistribution.data ?? {}).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="grid grid-cols-2 gap-5 items-start">
            <div className="bg-[var(--card)] rounded-card border border-[var(--border)]">
              <div className="px-6 pt-5 pb-3"><h2 className="text-label font-semibold text-[var(--text)]">Slowest pipeline stages</h2><p className="text-caption text-[var(--muted2)] mt-0.5">Average duration by span name</p></div>
              {(metrics?.slowestOperations.length ?? 0) === 0 ? <EmptyState title="No spans yet" message="Step timings appear once traces exist." /> : (
                <div className="divide-y divide-[var(--border)] pb-2">
                  {metrics!.slowestOperations.map(op => (
                    <div key={op.name} className="flex items-center gap-3 px-6 py-2.5">
                      <span className="flex-1 text-caption font-medium text-[var(--text)] truncate">{op.name}</span>
                      <span className="text-caption text-[var(--muted2)]">{op.count}×</span>
                      <span className="text-caption font-semibold text-[var(--text)] tabular-nums w-16 text-right">{fmtMs(op.avgDurationMs)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-[var(--card)] rounded-card border border-[var(--border)]">
              <div className="px-6 pt-5 pb-3"><h2 className="text-label font-semibold text-[var(--text)]">Most common errors</h2><p className="text-caption text-[var(--muted2)] mt-0.5">Select a code to see the requests that failed with it</p></div>
              {(metrics?.mostFrequentErrors.length ?? 0) === 0 ? <EmptyState title="No errors in range" message="No request failed in this period." /> : (
                <div className="divide-y divide-[var(--border)] pb-2">
                  {metrics!.mostFrequentErrors.map(e => (
                    <button key={e.errorCode} onClick={() => router.push(`/admin/rag-traces/errors?code=${encodeURIComponent(e.errorCode)}`)} className="group w-full flex items-center gap-3 px-6 py-2.5 hover:bg-[var(--surface)] transition-colors text-left">
                      {/* A chevron, not a bullet: these rows navigate, and a
                          dot down the left read as a list marker. */}
                      <span className="flex-1 text-caption font-mono text-[var(--text)] truncate">{e.errorCode}</span>
                      <span className="text-caption font-semibold text-[var(--gold)] tabular-nums">{e.count}</span>
                      <i className="fas fa-chevron-right text-[11px] text-[var(--muted2)] group-hover:text-[var(--accent)] transition-colors" aria-hidden="true" />
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
