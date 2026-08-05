'use client';

interface PaginationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  loading?: boolean;
  label?: string;
}

export function CursorPagination({ hasPrev, hasNext, onPrev, onNext, loading, label }: PaginationProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100">
      <p className="text-[13px] text-slate-400">{label}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={!hasPrev || loading}
          className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
          aria-label="Previous page"
        >
          <i className="fas fa-chevron-left text-[12px]" />
        </button>
        <button
          onClick={onNext}
          disabled={!hasNext || loading}
          className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
          aria-label="Next page"
        >
          <i className="fas fa-chevron-right text-[12px]" />
        </button>
      </div>
    </div>
  );
}
