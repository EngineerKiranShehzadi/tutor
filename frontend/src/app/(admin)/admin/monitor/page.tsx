'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { useAutoRefresh } from '@/components/observability/useAutoRefresh';
import { StatusBanner } from '@/components/monitor/StatusBanner';
import { WindowToggle } from '@/components/monitor/WindowToggle';
import { Figures, type Figure } from '@/components/monitor/Figures';
import { TrendChart } from '@/components/monitor/TrendChart';
import { FailureList } from '@/components/monitor/FailureList';
import { StageChart } from '@/components/monitor/StageChart';
import {
  monitorApi, isCanceled, MONITOR_WINDOWS,
  type MonitorSummary, type MonitorWindow, type PeriodSummary, type ReadinessResult,
} from '@/components/monitor/monitor-api';

const REFRESH_MS = 60_000;

// The two Diagnostics figures and the Phoenix links are for whoever is
// debugging retrieval, which is the same person who turns on Advanced
// Traces. Same flag, so a teacher running the course never meets them.
const DEV_TOOLS = process.env.NEXT_PUBLIC_DEV_TOOLS === 'true';

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtPct = (r: number | null) => (r === null ? null : `${(r * 100).toFixed(1)}%`);
const fmtUsd = (v: number | null) => (v === null ? null : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const n = (v: number) => v.toLocaleString();

/**
 * How much traffic a period needs before comparing it to the one before is
 * worth printing.
 *
 * Every figure used to carry "x% vs previous period". With 25 questions this
 * period against a few thousand left over from seeded test data, the page
 * reported a 99% collapse in gold, twice, and "same as the previous period"
 * under two zeros. A comparison drawn from almost no traffic is not a weak
 * signal, it is a wrong one, so below this it is not shown at all.
 */
const MIN_FOR_COMPARISON = 50;

const WINDOW_LABEL: Record<MonitorWindow, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** "12% more than the week before", or nothing. */
function compare(cur: number | null, prev: number | null, enough: boolean, unit: 'pct' | 'rel'): string | undefined {
  if (!enough || cur === null || prev === null) return undefined;
  if (unit === 'pct') {
    const pts = (cur - prev) * 100;
    if (Math.abs(pts) < 0.5) return undefined;
    return `${pts > 0 ? 'up' : 'down'} ${Math.abs(pts).toFixed(1)} points`;
  }
  if (prev === 0) return undefined;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 5) return undefined;
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}%`;
}

function MonitorContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = params.get('window');
  const windowKey: MonitorWindow = MONITOR_WINDOWS.includes(raw as MonitorWindow) ? (raw as MonitorWindow) : '24h';

  const [health, setHealth] = useState<ReadinessResult | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  // Bumped on every manual / automatic refresh so the sections below refetch
  // on their own; a window change refetches them via their own key.
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    // Independent: a failed health check must not hide the numbers, and
    // vice versa.
    const healthReq = monitorApi.getReadiness(signal)
      .then((h) => setHealth(h))
      .catch((e) => { if (!isCanceled(e)) setHealth(null); })
      .finally(() => { if (!signal.aborted) setHealthLoading(false); });

    const summaryReq = monitorApi.getSummary(windowKey, signal)
      .then((s) => { setSummary(s); setError(false); })
      .catch((e) => { if (!isCanceled(e)) setError(true); })
      .finally(() => { if (!signal.aborted) setLoading(false); });

    await Promise.all([healthReq, summaryReq]);
    if (!signal.aborted) setLastRefreshedAt(new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  const { setAutoRefresh, refresh, lastRefreshedAt, setLastRefreshedAt } = useAutoRefresh(() => { setTick((t) => t + 1); void load(); });

  useEffect(() => { setAutoRefresh(REFRESH_MS); }, [setAutoRefresh]);

  // Reload on mount and whenever the window changes.
  useEffect(() => {
    setLoading(true);
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const changeWindow = (w: MonitorWindow) => {
    const next = new URLSearchParams(params.toString());
    next.set('window', w);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const cur = summary?.window === windowKey ? summary.current : null;
  const prev = summary?.window === windowKey ? summary.previous : null;
  const cardsLoading = loading || !cur || !prev;

  // No questions in the period: there are no rates, no chart and no
  // failures, so the page says so once instead of in four empty panels.
  const quiet = !!cur && cur.totalRequests === 0;

  // Both periods have to carry real traffic before a comparison is printed.
  const comparable = !!cur && !!prev
    && cur.totalRequests >= MIN_FOR_COMPARISON && prev.totalRequests >= MIN_FOR_COMPARISON;

  const figures: Figure[] = [
    {
      label: 'Questions asked',
      value: cur ? n(cur.totalRequests) : null,
      note: compare(cur?.totalRequests ?? null, prev?.totalRequests ?? null, comparable, 'rel'),
    },
    {
      label: 'Answered from the material',
      value: cur ? fmtPct(cur.answeredRate) : null,
      note: compare(cur?.answeredRate ?? null, prev?.answeredRate ?? null, comparable, 'pct'),
    },
    {
      label: 'Not in the uploaded material',
      value: cur ? fmtPct(cur.notFoundRate) : null,
      note: compare(cur?.notFoundRate ?? null, prev?.notFoundRate ?? null, comparable, 'pct'),
    },
    {
      // The number this page exists to surface. Gold once a typical answer
      // crosses the threshold the system itself calls slow, because at that
      // point it is not a statistic, it is what a student is sitting through.
      // The note says how many waited, so the colour explains itself rather
      // than being an unexplained red number with jargon under it.
      label: 'Typical answer time',
      value: cur && cur.p50Ms !== null ? fmtMs(cur.p50Ms) : null,
      note: cur && cur.slowCount > 0
        ? `${n(cur.slowCount)} of ${n(cur.totalRequests)} waited over ${fmtMs(cur.slowThresholdMs)}`
        : cur && cur.p95Ms !== null ? `the slowest took ${fmtMs(cur.p95Ms)}` : undefined,
      warn: !!cur && cur.p50Ms !== null && cur.p50Ms > cur.slowThresholdMs,
    },
    {
      label: 'Failed to answer',
      value: cur ? n(cur.errorCount) : null,
      note: cur && cur.errorCount > 0 && cur.errorRate !== null ? `${fmtPct(cur.errorRate)} of questions` : undefined,
      warn: !!cur && cur.errorCount > 0,
    },
  ];

  return (
    <div className="max-w-[1180px] min-w-0">
      <AdminPageHero
        icon="fas fa-heart-pulse"
        iconGradient=" "
        title="Tutor Health"
        subtitle="Whether the tutor is working, how long it takes to answer, and what went wrong."
        action={
          <div className="flex items-center gap-3">
            <WindowToggle value={windowKey} onChange={changeWindow} />
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh now"
              className="w-9 h-9 rounded-control border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors"
            >
              <i className={`fas fa-rotate text-caption ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      />

      {/* No time on this line: the page already says when it last refreshed,
          under the figures, and saying it twice is how a page fills up. */}
      <StatusBanner health={health} loading={healthLoading} />

      {error && !summary ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] py-16 flex flex-col items-center text-center px-8">
          <i className="fas fa-triangle-exclamation text-h1 text-[var(--gold)] mb-3" />
          <p className="text-label font-semibold text-[var(--text)]">Could not load the numbers</p>
          <p className="text-caption text-[var(--muted2)] mt-1">Please try again in a moment.</p>
          <button type="button" onClick={refresh} className="mt-4 h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors">Try again</button>
        </div>
      ) : (
        <>
          {error && <p className="text-caption text-[var(--gold)] mb-3">Couldn't fetch the latest numbers — showing the previous ones.</p>}
          {quiet ? (
            /* Shown the way every other "nothing here" on this page is
               shown, rather than as a loose sentence under the heading. */
            <div className="rounded-card border border-[var(--border)] bg-[var(--card)] py-12 px-8 flex flex-col items-center text-center">
              <i className="fas fa-chart-column text-h1 text-[var(--muted2)] mb-3" aria-hidden="true" />
              <p className="text-label font-semibold text-[var(--muted)]">No questions were asked in this period</p>
              <p className="text-caption text-[var(--muted2)] mt-1">
                Choose a longer period above to see how the tutor has been doing.
              </p>
            </div>
          ) : (
          <>
          {/* The period in words. Overview counts every question ever asked,
              this page counts the ones in the window, and the two numbers
              being wildly different needs to be obvious rather than worked
              out from a toggle in the corner. */}
          <p className="text-caption font-semibold text-[var(--muted)] mb-2">{WINDOW_LABEL[windowKey]}</p>
          {/* One row, in the order the question travels: how many came in,
              what became of them, how long it took, how many failed. */}
          <Figures loading={cardsLoading} items={figures} />
          </>
          )}
          {/* One quiet footer, not a stack of loose sentences under the
              figures. Cost is a fact about the period rather than a measure
              of health, so it sits here with the clock. */}
          <p className="text-caption text-[var(--muted)] mt-4">
            {!quiet && cur && cur.totalCostUsd !== null && (
              <>Model cost for this period: about {fmtUsd(cur.totalCostUsd)}, estimated from token counts. · </>
            )}
            {lastRefreshedAt
              ? <>Updated {lastRefreshedAt.toLocaleTimeString()}, and every 60 seconds</>
              : <>Refreshes every 60 seconds</>}
          </p>
          {DEV_TOOLS && cur && !quiet && (
            <p className="text-caption text-[var(--muted)] mt-1">
              Developer diagnostics — answer cache skipped because personal data was masked: {n(cur.memorySkippedForPii)} ·
              answers sent as plain text when a list or table was asked for: {n(cur.formatRepairsRefused)}
            </p>
          )}
        </>
      )}

      {/* Nothing below here has anything to say about a period with no
          questions in it, and four boxes each announcing that separately is
          how the page looked when the course was quiet. */}
      {!quiet && (
        <div className="mt-6 space-y-5 min-w-0">
          <TrendChart windowKey={windowKey} tick={tick} />
          <FailureList windowKey={windowKey} tick={tick} />
          {/* By lecture lived here too: questions, answered, not found and
              response time per lecture. Content Gaps already ranks the
              lectures by unanswered questions and then lists the questions,
              which is the same finding with the next step attached. One
              fact, one page. */}
          <StageChart windowKey={windowKey} tick={tick} />
        </div>
      )}
    </div>
  );
}

// useSearchParams needs a Suspense boundary for Next's static build.
export default function MonitorPage() {
  return (
    <Suspense fallback={null}>
      <MonitorContent />
    </Suspense>
  );
}
