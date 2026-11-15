'use client';
import { monitorApi, type MonitorWindow, type StageStats } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';
import { stageLabel } from '@/lib/monitor-labels';

/**
 * Why an answer takes as long as it does.
 *
 * This was a bar chart of each step's p95, and it was misleading twice over.
 * p95 is the slowest one in twenty, so a step that ran three times and was
 * slow once drew a bar three minutes long and flattened every step that runs
 * on every question into a stub against it. And nothing said how often a
 * step ran, so there was no way to tell the two apart.
 *
 * It is a list now: the typical time for each step, how many times it ran,
 * and its slowest. Sorted by typical time, because the question is where a
 * normal answer spends its seconds. A bar is kept as a proportion of the
 * slowest typical step, which is a comparison that holds.
 */

// Six, not eight. Past the sixth the bars are stubs and the list is just
// long; the point is which two or three steps hold everything up.
const MAX_STEPS = 6;
const fmt = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function StageChart({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<StageStats[]>(
    (s) => monitorApi.getStages(windowKey, s), windowKey, tick);

  const steps = [...(data ?? [])].sort((a, b) => b.p50Ms - a.p50Ms).slice(0, MAX_STEPS);
  const slowest = steps[0]?.p50Ms ?? 1;

  return (
    <SectionCard
      title="Why answers take as long as they do"
      subtitle="The typical time each step takes, longest first. Use it to see which step to speed up when answers are slow."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && steps.length === 0}
      emptyText="No step timings were recorded"
      emptyIcon="fas fa-stopwatch"
      onRetry={reload}
    >
      <ul className="space-y-3.5">
        {steps.map((s) => (
          <li key={s.stage}>
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-label text-[var(--text)] truncate">{stageLabel(s.stage)}</p>
              {/* Said in words. A number alone on the right of a bar is a
                  number the reader has to guess the meaning of. */}
              <p className="shrink-0 text-label text-[var(--text)] tabular-nums">
                {fmt(s.p50Ms)}<span className="text-caption text-[var(--muted2)]"> typically</span>
              </p>
            </div>
            {/* The pale navy, not the full one. Six solid accent bars down a
                card is a block of colour the eye cannot separate; the bar
                only has to show one step against the next. */}
            <div className="mt-1.5 h-1.5 rounded-full bg-[var(--surface)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent-dim)]"
                style={{ width: `${Math.max((s.p50Ms / slowest) * 100, 2)}%` }}
              />
            </div>
            {/* How often it ran, so a step that happens on three questions
                in a hundred is not read as part of every answer. */}
            <p className="text-caption text-[var(--muted2)] mt-1">
              ran {s.count.toLocaleString()} {s.count === 1 ? 'time' : 'times'} · slowest {fmt(s.p95Ms)}
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
