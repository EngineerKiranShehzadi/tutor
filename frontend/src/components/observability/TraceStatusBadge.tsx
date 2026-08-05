'use client';
import { cn } from '@/lib/cn';

const STYLES: Record<string, string> = {
  SUCCESS: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  OK: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ERROR: 'bg-red-50 text-red-700 border-red-200',
  FALLBACK: 'bg-amber-50 text-amber-700 border-amber-200',
  SKIPPED: 'bg-slate-100 text-slate-500 border-slate-200',
  UNSET: 'bg-slate-100 text-slate-500 border-slate-200',
  UNKNOWN: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function TraceStatusBadge({ status, className }: { status: string; className?: string }) {
  const key = (status || 'UNKNOWN').toUpperCase();
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border uppercase tracking-wide', STYLES[key] ?? STYLES.UNKNOWN, className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', key === 'SUCCESS' || key === 'OK' ? 'bg-emerald-500' : key === 'ERROR' ? 'bg-red-500' : key === 'FALLBACK' ? 'bg-amber-500' : 'bg-slate-400')} />
      {status || 'Unknown'}
    </span>
  );
}
