'use client';
import type { ReactNode } from 'react';

interface SectionCardProps {
  title: string;
  subtitle?: string;
  loading: boolean;
  error: boolean;
  hasData: boolean; // data loaded (possibly stale after a failed refresh)
  empty: boolean; // loaded but nothing to show
  emptyText: string;
  emptyIcon?: string;
  onRetry: () => void;
  /** A link out of this section, set beside its heading. */
  headerAction?: ReactNode;
  skeleton?: ReactNode;
  children: ReactNode;
}

const DefaultSkeleton = () => (
  <div className="space-y-3" aria-hidden="true">
    {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-card bg-[var(--surface)] animate-pulse" />)}
  </div>
);

// Shell shared by the four monitor sections: same look as the summary cards,
// plus independent loading / empty / error states.
export function SectionCard({ title, subtitle, loading, error, hasData, empty, emptyText, emptyIcon = 'fas fa-inbox', onRetry, headerAction, skeleton, children }: SectionCardProps) {
  let body: ReactNode;
  if (loading && !hasData) {
    body = <div role="status" aria-label={`Loading ${title}`}>{skeleton ?? <DefaultSkeleton />}</div>;
  } else if (error && !hasData) {
    body = (
      <div className="py-10 flex flex-col items-center text-center">
        <i className="fas fa-triangle-exclamation text-h1 text-[var(--gold)] mb-3" />
        <p className="text-label font-semibold text-[var(--text)]">Could not load this section</p>
        <p className="text-caption text-[var(--muted2)] mt-1">The other sections are not affected.</p>
        <button type="button" onClick={onRetry} className="mt-4 px-4 py-2 rounded-control bg-[var(--ink)] text-white text-caption font-semibold">Try again</button>
      </div>
    );
  } else if (empty) {
    body = (
      <div className="py-10 flex flex-col items-center text-center">
        <i className={`${emptyIcon} text-h1 text-[var(--muted2)] mb-3`} />
        <p className="text-label font-semibold text-[var(--muted)]">{emptyText}</p>
      </div>
    );
  } else {
    body = <>{children}</>;
  }
  return (
    <section className="bg-[var(--card)] rounded-card border border-[var(--border)] p-6 min-w-0">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-label font-semibold text-[var(--text)]">{title}</h2>
          {subtitle && <p className="text-caption text-[var(--muted2)] mt-0.5">{subtitle}</p>}
          {error && hasData && <p className="text-caption text-[var(--gold)] mt-1">Couldn't refresh — showing the previous numbers.</p>}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      {body}
    </section>
  );
}
