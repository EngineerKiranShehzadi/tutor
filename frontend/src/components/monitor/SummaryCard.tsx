'use client';
import { useId } from 'react';

// "up" = value went up. `goodWhen` says which direction is good for this
// metric (more answers = good, more not-found = bad); 'neutral' = neither
// (e.g. number of questions asked).
export interface Change {
  direction: 'up' | 'down' | 'same';
  text: string; // e.g. "12%" or "3 pt"
  goodWhen: 'up' | 'down' | 'neutral';
}

interface SummaryCardProps {
  label: string;
  value: string | null; // null renders "—"
  subValue?: string;
  tooltip: string;
  icon: string;
  accent: 'indigo' | 'emerald' | 'amber' | 'violet' | 'red' | 'cyan';
  change: Change | null; // null = nothing to compare against
  loading?: boolean;
}

const ACCENTS: Record<SummaryCardProps['accent'], string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
  red: 'bg-red-50 text-red-600',
  cyan: 'bg-cyan-50 text-cyan-600',
};

function ChangeLine({ change }: { change: Change | null }) {
  if (!change) return <span className="text-[12px] text-slate-400">No previous period to compare</span>;
  if (change.direction === 'same') return <span className="text-[12px] font-semibold text-slate-400">→ Same as previous period</span>;
  const tone = change.goodWhen === 'neutral'
    ? 'text-slate-500'
    : change.direction === change.goodWhen ? 'text-emerald-600' : 'text-red-600';
  return (
    <span className={`text-[12px] font-bold ${tone}`}>
      {change.direction === 'up' ? '▲' : '▼'} {change.text}
      <span className="font-medium text-slate-400"> vs previous period</span>
    </span>
  );
}

export function SummaryCard({ label, value, subValue, tooltip, icon, accent, change, loading }: SummaryCardProps) {
  const tipId = useId();
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
      <div className="flex items-start justify-between mb-5">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${ACCENTS[accent]}`}>
          <i className={`${icon} text-[15px]`} />
        </div>
        <div className="relative group">
          <button type="button" aria-label={`About ${label}`} aria-describedby={tipId} className="text-slate-300 hover:text-slate-500 focus:text-slate-500 outline-none">
            <i className="fas fa-circle-info text-[13px]" />
          </button>
          <div
            id={tipId}
            role="tooltip"
            className="pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity absolute right-0 top-6 z-10 w-56 bg-slate-900 text-white text-[12px] rounded-lg px-3 py-2 shadow-xl leading-snug"
          >
            {tooltip}
          </div>
        </div>
      </div>

      {loading ? (
        <>
          <div className="h-9 w-24 rounded-lg bg-slate-100 animate-pulse mb-2" />
          <div className="h-4 w-32 rounded bg-slate-100 animate-pulse" />
        </>
      ) : (
        <>
          <p className={`text-[32px] font-extrabold leading-none ${value === null ? 'text-slate-300' : 'text-slate-900'}`}>{value ?? '—'}</p>
          {subValue && <p className="text-[12px] text-slate-400 mt-1.5">{subValue}</p>}
          <p className="text-[13px] text-slate-500 font-medium mt-2">{label}</p>
          <div className="mt-1"><ChangeLine change={change} /></div>
        </>
      )}
    </div>
  );
}
