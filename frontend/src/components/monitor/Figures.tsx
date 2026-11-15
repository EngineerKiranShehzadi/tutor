'use client';
import { fieldLabel } from '@/lib/ui';

/**
 * The headline figures, as figures.
 *
 * These were seven white cards in a grid, each with an icon, a label, an info
 * circle, a number, a sub-line and a comparison — the shape every generated
 * admin template arrives in. Seven boxes of equal weight say "here are seven
 * things" and leave the reader to work out which one matters.
 *
 * So: one row of plain numbers between two rules, no boxes and no icons,
 * reading left to right in the order the question travels — how many were
 * asked, what became of them, how long it took, how many failed.
 */

export interface Figure {
  label: string;
  value: string | null;
  /** One short line under the number. Not a second number competing with it. */
  note?: string;
  /** Draws the number in gold. For the one thing that is actually wrong. */
  warn?: boolean;
}

export function Figures({ items, loading }: { items: Figure[]; loading: boolean }) {
  return (
    <dl className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-y-7 border-y border-[var(--border)] py-5">
      {items.map((f, i) => (
        <div
          key={f.label}
          /* A hairline between each figure and the next, dropped on the first
             so nothing hangs off the left edge. It separates without closing
             anything in, which a border on all four sides would. */
          className={`min-w-0 px-6 first:pl-0 ${i > 0 ? 'lg:border-l border-[var(--border)]' : ''}`}
        >
          <dt className={fieldLabel}>{f.label}</dt>
          {/* Loading and "there is no such number" are different states. They
              were the same test, so a period with no questions in it sat
              shimmering for ever, waiting for a figure that does not exist. */}
          {loading ? (
            <dd className="h-8 w-20 rounded bg-[var(--surface)] animate-pulse mt-1.5" aria-hidden="true" />
          ) : f.value === null ? (
            <dd className="text-h1 font-semibold text-[var(--muted2)] mt-0.5">—</dd>
          ) : (
            <dd className={`text-h1 font-semibold tabular-nums mt-0.5 ${f.warn ? 'text-[var(--gold)]' : 'text-[var(--text)]'}`}>
              {f.value}
            </dd>
          )}
          {f.note && !loading && <p className="text-caption text-[var(--muted2)] mt-0.5">{f.note}</p>}
        </div>
      ))}
    </dl>
  );
}
