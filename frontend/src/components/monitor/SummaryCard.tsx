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
  /**
   * Kept so existing callers compile; the card no longer tints anything.
   * It used to map six metrics onto six hues — indigo, emerald, amber,
   * violet, red and cyan — none of which exist in the theme, and none of
   * which said anything the label did not.
   */
  accent?: string;
  change: Change | null; // null = nothing to compare against
  loading?: boolean;
}

function ChangeLine({ change }: { change: Change | null }) {
  if (!change) return <span className="text-caption text-[var(--muted2)]">No previous period to compare</span>;
  if (change.direction === 'same') return <span className="text-caption text-[var(--muted)]">Same as the previous period</span>;
  // Navy when the number moved the way you want, gold when it did not, and
  // plain grey when the metric has no good direction.
  const tone = change.goodWhen === 'neutral'
    ? 'text-[var(--muted)]'
    : change.direction === change.goodWhen ? 'text-[var(--accent)]' : 'text-[var(--gold)]';
  return (
    <span className={`text-caption font-medium ${tone}`}>
      {change.direction === 'up' ? '▲' : '▼'} {change.text}
      <span className="font-normal text-[var(--muted2)]"> vs previous period</span>
    </span>
  );
}

export function SummaryCard({ label, value, subValue, tooltip, icon, change, loading }: SummaryCardProps) {
  const tipId = useId();
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
      {/* The label comes first, as it does on Overview: the number means
          nothing until you know what it counts. The tinted icon tile that
          used to sit here has gone; the icon rides beside the label. */}
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-caption font-medium text-[var(--muted)]">
          <i className={`${icon} text-caption text-[var(--muted2)]`} aria-hidden="true" />
          {label}
        </p>
        <div className="relative group shrink-0">
          <button
            type="button"
            aria-label={`About ${label}`}
            aria-describedby={tipId}
            className="text-[var(--muted2)] hover:text-[var(--muted)] focus:text-[var(--muted)] outline-none transition-colors"
          >
            <i className="fas fa-circle-info text-caption" />
          </button>
          <div
            id={tipId}
            role="tooltip"
            className="pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity absolute right-0 top-6 z-10 w-56 rounded-control bg-[var(--ink)] px-3 py-2 text-caption leading-snug text-white shadow-[0_8px_24px_rgba(22,26,31,0.22)]"
          >
            {tooltip}
          </div>
        </div>
      </div>

      {loading ? (
        <>
          <div className="h-8 w-24 rounded-control bg-[var(--surface)] animate-pulse mt-3" />
          <div className="h-4 w-32 rounded-control bg-[var(--surface)] animate-pulse mt-2.5" />
        </>
      ) : (
        <>
          <p className={`text-h1 font-semibold leading-none tabular-nums mt-3 ${value === null ? 'text-[var(--muted2)]' : 'text-[var(--text)]'}`}>
            {value ?? '—'}
          </p>
          {subValue && <p className="text-caption text-[var(--muted)] mt-2">{subValue}</p>}
          <div className="mt-2"><ChangeLine change={change} /></div>
        </>
      )}
    </div>
  );
}
