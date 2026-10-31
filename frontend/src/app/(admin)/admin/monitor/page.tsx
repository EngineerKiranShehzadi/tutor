'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { useAutoRefresh } from '@/components/observability/useAutoRefresh';
import { StatusBanner } from '@/components/monitor/StatusBanner';
import { WindowToggle } from '@/components/monitor/WindowToggle';
import { SummaryCard, type Change } from '@/components/monitor/SummaryCard';
import { TrendChart } from '@/components/monitor/TrendChart';
import { AttentionTable } from '@/components/monitor/AttentionTable';
import { LectureTable } from '@/components/monitor/LectureTable';
import { StageChart } from '@/components/monitor/StageChart';
import {
  monitorApi, isCanceled, MONITOR_WINDOWS,
  type MonitorSummary, type MonitorWindow, type PeriodSummary, type ReadinessResult,
} from '@/components/monitor/monitor-api';

const REFRESH_MS = 60_000;

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtPct = (r: number | null) => (r === null ? null : `${(r * 100).toFixed(1)}%`);
const fmtUsd = (v: number | null) => (v === null ? null : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const errorCount = (p: PeriodSummary) => Math.round((p.errorRate ?? 0) * p.totalRequests);

// Relative change (counts, latency, cost). null when there is no baseline.
function relChange(cur: number | null, prev: number | null, goodWhen: Change['goodWhen']): Change | null {
  if (cur === null || prev === null) return null;
  if (cur === prev) return { direction: 'same', text: '', goodWhen };
  if (prev === 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return { direction: 'same', text: '', goodWhen };
  return { direction: pct > 0 ? 'up' : 'down', text: `${Math.abs(pct).toFixed(0)}%`, goodWhen };
}

// Percentage-point change for 0..1 rates.
function rateChange(cur: number | null, prev: number | null, goodWhen: Change['goodWhen']): Change | null {
  if (cur === null || prev === null) return null;
  const pts = (cur - prev) * 100;
  if (Math.abs(pts) < 0.05) return { direction: 'same', text: '', goodWhen };
  return { direction: pts > 0 ? 'up' : 'down', text: `${Math.abs(pts).toFixed(1)} pt`, goodWhen };
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

  return (
    <div className="max-w-[1500px] min-w-0">
      <AdminPageHero
        icon="fas fa-heart-pulse"
        iconGradient="from-emerald-500 to-teal-600"
        title="AI Tutor Monitor"
        subtitle="How the AI tutor is doing, at a glance."
        action={
          <div className="flex items-center gap-3">
            <WindowToggle value={windowKey} onChange={changeWindow} />
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh now"
              className="w-9 h-9 rounded-xl bg-white/10 border border-white/20 text-white/80 hover:text-white"
            >
              <i className={`fas fa-rotate text-[13px] ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      />

      <StatusBanner health={health} loading={healthLoading} />

      {error && !summary ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 flex flex-col items-center text-center px-8">
          <i className="fas fa-triangle-exclamation text-2xl text-red-400 mb-3" />
          <p className="text-[15px] font-semibold text-slate-700">Could not load the numbers</p>
          <p className="text-[13px] text-slate-400 mt-1">Please try again in a moment.</p>
          <button type="button" onClick={refresh} className="mt-4 px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold">Try again</button>
        </div>
      ) : (
        <>
          {error && <p className="text-[12px] text-amber-600 mb-3">Couldn't fetch the latest numbers — showing the previous ones.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
            <SummaryCard
              loading={cardsLoading}
              label="Questions asked"
              icon="fas fa-comments"
              accent="indigo"
              tooltip="How many questions students asked in this period."
              value={cur ? cur.totalRequests.toLocaleString() : null}
              change={cur && prev ? relChange(cur.totalRequests, prev.totalRequests, 'neutral') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="Answered"
              icon="fas fa-circle-check"
              accent="emerald"
              tooltip="Share of questions answered from the lecture. Higher is better."
              value={cur ? fmtPct(cur.answeredRate) : null}
              change={cur && prev ? rateChange(cur.answeredRate, prev.answeredRate, 'up') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="Not found in lecture"
              icon="fas fa-magnifying-glass-minus"
              accent="amber"
              tooltip="Share of questions the lecture had no answer for. Lower is better."
              value={cur ? fmtPct(cur.notFoundRate) : null}
              change={cur && prev ? rateChange(cur.notFoundRate, prev.notFoundRate, 'down') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="Response time"
              icon="fas fa-stopwatch"
              accent="violet"
              tooltip="Typical time to answer (median). The p95 below is the time that 19 out of 20 answers beat."
              value={cur && cur.p50Ms !== null ? fmtMs(cur.p50Ms) : null}
              subValue={cur && cur.p95Ms !== null ? `p95: ${fmtMs(cur.p95Ms)}` : undefined}
              change={cur && prev ? relChange(cur.p50Ms, prev.p50Ms, 'down') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="Errors"
              icon="fas fa-circle-exclamation"
              accent="red"
              tooltip="Questions where something failed and no answer could be produced. Lower is better."
              value={cur ? errorCount(cur).toLocaleString() : null}
              subValue={cur && cur.errorRate !== null ? `${fmtPct(cur.errorRate)} of questions` : undefined}
              change={cur && prev ? relChange(errorCount(cur), errorCount(prev), 'down') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="LLM cost"
              icon="fas fa-coins"
              accent="cyan"
              tooltip="Estimated AI model spend in this period (USD). Shows — when no cost was recorded."
              value={cur ? fmtUsd(cur.totalCostUsd) : null}
              change={cur && prev ? relChange(cur.totalCostUsd, prev.totalCostUsd, 'down') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="Answer cache skipped"
              icon="fas fa-user-shield"
              accent="indigo"
              tooltip="Questions answered without the answer cache because personal data in them (a phone number, an email…) was masked. Masked questions can't be told apart, so their answers are never cached or reused. They are still answered normally."
              value={cur ? cur.memorySkippedForPii.toLocaleString() : null}
              subValue="personal data was masked"
              change={cur && prev ? relChange(cur.memorySkippedForPii, prev.memorySkippedForPii, 'neutral') : null}
            />
            <SummaryCard
              loading={cardsLoading}
              label="List/table not delivered"
              icon="fas fa-table-list"
              accent="amber"
              tooltip="Questions that asked for a list or a table but got the answer as plain text: the reformatted answer was refused because it added or dropped content. The answer itself was still correct. Lower is better."
              value={cur ? cur.formatRepairsRefused.toLocaleString() : null}
              subValue="sent as plain text"
              change={cur && prev ? relChange(cur.formatRepairsRefused, prev.formatRepairsRefused, 'down') : null}
            />
          </div>
          {lastRefreshedAt && (
            <p className="text-[12px] text-slate-400 mt-4">
              Last updated: {lastRefreshedAt.toLocaleTimeString()} · refreshes automatically every 60 seconds
            </p>
          )}
        </>
      )}

      <div className="mt-5 space-y-5 min-w-0">
        <TrendChart windowKey={windowKey} tick={tick} />
        <AttentionTable tick={tick} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 min-w-0">
          <LectureTable windowKey={windowKey} tick={tick} />
          <StageChart windowKey={windowKey} tick={tick} />
        </div>
      </div>
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
