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

const ACCENTS: Record<string, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  red: 'bg-red-50 text-red-600',
  amber: 'bg-amber-50 text-amber-600',
  cyan: 'bg-cyan-50 text-cyan-600',
  violet: 'bg-violet-50 text-violet-600',
};

export function MetricCard({
  label, value, tooltip, icon, accent = 'indigo', comparisonPct, loading,
  available, unavailableReason, emptyMessage, sampleNote,
}: MetricCardProps) {
  const isUnavailable = value === null && (available === undefined ? true : !available);
  const isEmpty = value === null && !isUnavailable;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow group relative">
      <div className="flex items-start justify-between mb-5">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${ACCENTS[accent] ?? ACCENTS.indigo}`}>
          <i className={`${icon} text-[15px]`} />
        </div>
        <div className="relative">
          <i className="fas fa-circle-info text-slate-300 text-[13px] cursor-help peer" />
          <div className="pointer-events-none peer-hover:opacity-100 opacity-0 transition-opacity absolute right-0 top-6 z-10 w-56 bg-slate-900 text-white text-[12px] rounded-lg px-3 py-2 shadow-xl leading-snug">
            {tooltip}
          </div>
        </div>
      </div>
      {loading ? (
        <div className="h-9 w-20 rounded-lg bg-slate-100 animate-pulse mb-1" />
      ) : isUnavailable ? (
        <div className="py-1" title={unavailableReason}>
          <p className="text-[15px] font-semibold text-slate-300 leading-none">Unavailable</p>
          {unavailableReason && <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">{unavailableReason}</p>}
        </div>
      ) : isEmpty ? (
        <p className="text-[14px] font-medium text-slate-400 italic leading-snug py-2">{emptyMessage ?? 'No data'}</p>
      ) : (
        <p className="text-[32px] font-extrabold text-slate-900 leading-none">{value}</p>
      )}
      <div className="flex items-center gap-2 mt-2">
        <p className="text-[13px] text-slate-500 font-medium">{label}</p>
        {comparisonPct !== undefined && comparisonPct !== null && !loading && (
          <span className={`text-[11px] font-bold ${comparisonPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {comparisonPct >= 0 ? '▲' : '▼'} {Math.abs(comparisonPct).toFixed(0)}%
          </span>
        )}
      </div>
      {!loading && sampleNote && !isUnavailable && (
        <p className="text-[11px] text-slate-400 mt-1.5">{sampleNote}</p>
      )}
    </div>
  );
}
