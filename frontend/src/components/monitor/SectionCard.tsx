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
  skeleton?: ReactNode;
  children: ReactNode;
}

const DefaultSkeleton = () => (
  <div className="space-y-3" aria-hidden="true">
    {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-lg bg-slate-100 animate-pulse" />)}
  </div>
);

// Shell shared by the four monitor sections: same look as the summary cards,
// plus independent loading / empty / error states.
export function SectionCard({ title, subtitle, loading, error, hasData, empty, emptyText, emptyIcon = 'fas fa-inbox', onRetry, skeleton, children }: SectionCardProps) {
  let body: ReactNode;
  if (loading && !hasData) {
    body = <div role="status" aria-label={`Loading ${title}`}>{skeleton ?? <DefaultSkeleton />}</div>;
  } else if (error && !hasData) {
    body = (
      <div className="py-10 flex flex-col items-center text-center">
        <i className="fas fa-triangle-exclamation text-2xl text-red-400 mb-3" />
        <p className="text-[14px] font-semibold text-slate-700">Could not load this section</p>
        <p className="text-[13px] text-slate-400 mt-1">The other sections are not affected.</p>
        <button type="button" onClick={onRetry} className="mt-4 px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold">Try again</button>
      </div>
    );
  } else if (empty) {
    body = (
      <div className="py-10 flex flex-col items-center text-center">
        <i className={`${emptyIcon} text-2xl text-slate-300 mb-3`} />
        <p className="text-[14px] font-semibold text-slate-600">{emptyText}</p>
      </div>
    );
  } else {
    body = <>{children}</>;
  }
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm min-w-0">
      <div className="mb-4">
        <h2 className="text-[16px] font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-[12px] text-slate-400 mt-0.5">{subtitle}</p>}
        {error && hasData && <p className="text-[12px] text-amber-600 mt-1">Couldn't refresh — showing the previous numbers.</p>}
      </div>
      {body}
    </section>
  );
}
