'use client';

interface PaginationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  loading?: boolean;
  label?: string;
}

/**
 * Sits below the table, on the page, not inside it.
 *
 * It used to be the last thing inside the card, with a rule above it, which
 * gave it the width, the padding and the top border of a table row. It read
 * as one more row of the table, except it held a sentence and two arrows.
 * The count and the arrows belong together, so the count sits beside them
 * rather than at the far end of an empty strip.
 */
export function CursorPagination({ hasPrev, hasNext, onPrev, onNext, loading, label }: PaginationProps) {
  return (
    <div className="flex items-center gap-3 mt-3">
      <p className="text-caption text-[var(--muted2)]">{label}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={!hasPrev || loading}
          className="w-9 h-9 rounded-control border border-[var(--border)] flex items-center justify-center text-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--surface)] transition-colors"
          aria-label="Previous page"
        >
          <i className="fas fa-chevron-left text-caption" />
        </button>
        <button
          onClick={onNext}
          disabled={!hasNext || loading}
          className="w-9 h-9 rounded-control border border-[var(--border)] flex items-center justify-center text-[var(--muted)] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--surface)] transition-colors"
          aria-label="Next page"
        >
          <i className="fas fa-chevron-right text-caption" />
        </button>
      </div>
    </div>
  );
}
