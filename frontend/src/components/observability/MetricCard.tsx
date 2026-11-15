'use client';

interface MetricCardProps {
  label: string;
  value: string | number | null; // null => unavailable OR no-observations (see `available`/`emptyMessage`), rendered distinctly from a real 0
  tooltip: string;
  icon: string;
  accent?: string; // Tailwind color class prefix, e.g. 'indigo'
  comparisonPct?: number | null; // vs preceding period, when computable
  loading?: boolean;
  // Distinguishes "the telemetry genuinely couldn't be fetched" (true
  // "Unavailable", styling stays the same as before) from "it was fetched
  // fine but there's nothing to measure this window" (a softer, non-alarming
  // no-data state). Defaults to `value === null` so existing callers that
  // never pass this keep their old behavior unchanged.
  available?: boolean;
  // Supporting detail shown under "Unavailable" when available === false —
  // e.g. "Phoenix is temporarily unreachable."
  unavailableReason?: string;
  // Shown instead of "Unavailable" when value === null but available !== false
  // — e.g. "No memory lookups in this period" / "No traces in this period".
  emptyMessage?: string;
  // Sampling disclosure, shown under the value/label whenever this metric
  // was computed from a bounded recent sample rather than the full window
  // — e.g. "Based on the most recent 100 requests".
  sampleNote?: string;
}

export function MetricCard({
  label, value, tooltip, icon, comparisonPct, loading,
  available, unavailableReason, emptyMessage, sampleNote,
}: MetricCardProps) {
  const isUnavailable = value === null && (available === undefined ? true : !available);
  const isEmpty = value === null && !isUnavailable;

  return (
    <div className="bg-[var(--card)] rounded-card border border-[var(--border)] p-5 group relative">
      {/* Built the same way as SummaryCard on Tutor Health: the label and a
          small icon, then the number. The tinted icon tile is gone — six
          accent names all pointed at the same two colours anyway. */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="flex items-center gap-2 text-caption font-medium text-[var(--muted)]">
          <i className={`${icon} text-[12px] text-[var(--muted2)]`} aria-hidden="true" />
          {label}
        </p>
        <div className="relative shrink-0">
          <i className="fas fa-circle-info text-[var(--muted2)] text-caption cursor-help peer" />
          <div className="pointer-events-none peer-hover:opacity-100 opacity-0 transition-opacity absolute right-0 top-6 z-10 w-56 bg-[var(--ink)] text-white text-caption rounded-control px-3 py-2 leading-snug shadow-[0_8px_24px_rgba(22,26,31,0.22)]">
            {tooltip}
          </div>
        </div>
      </div>
      {loading ? (
        <div className="h-9 w-20 rounded-card bg-[var(--surface)] animate-pulse mb-1" />
      ) : isUnavailable ? (
        <div className="py-1" title={unavailableReason}>
          <p className="text-label font-semibold text-[var(--muted2)] leading-none">Unavailable</p>
          {unavailableReason && <p className="text-[11px] text-[var(--muted2)] mt-1.5 leading-snug">{unavailableReason}</p>}
        </div>
      ) : isEmpty ? (
        <p className="text-label font-medium text-[var(--muted2)] italic leading-snug py-2">{emptyMessage ?? 'No data'}</p>
      ) : (
        <p className="text-h1 font-semibold text-[var(--text)] leading-none tabular-nums">{value}</p>
      )}
      {comparisonPct !== undefined && comparisonPct !== null && !loading && (
        <p className={`text-caption font-medium mt-2 ${comparisonPct >= 0 ? 'text-[var(--accent)]' : 'text-[var(--gold)]'}`}>
          {comparisonPct >= 0 ? '▲' : '▼'} {Math.abs(comparisonPct).toFixed(0)}%
          <span className="font-normal text-[var(--muted2)]"> vs previous period</span>
        </p>
      )}
      {!loading && sampleNote && !isUnavailable && (
        <p className="text-[11px] text-[var(--muted2)] mt-1.5">{sampleNote}</p>
      )}
    </div>
  );
}
