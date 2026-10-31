'use client';
import { useEffect, useRef, useState } from 'react';
import { monitorApi, isCanceled, type AttentionPage, type AttentionRow } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';
import { attentionDetailLabels, attentionReasonLabel } from '@/lib/monitor-labels';

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function relativeTime(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const CHIP_TONE: Record<string, string> = {
  error: 'bg-red-50 text-red-700',
  not_answered: 'bg-amber-50 text-amber-700',
  verifier: 'bg-violet-50 text-violet-700',
  format: 'bg-orange-50 text-orange-700',
  slow: 'bg-sky-50 text-sky-700',
};

function Row({ row }: { row: AttentionRow }) {
  const details = attentionDetailLabels(row);
  const title = row.lectureTitle ?? 'Unknown lecture';
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="py-3 pr-4 whitespace-nowrap text-slate-600">
        <span title={new Date(row.createdAt).toLocaleString()}>{relativeTime(row.createdAt)}</span>
      </td>
      <td className="py-3 pr-4 max-w-[200px]">
        <span className="block truncate text-slate-800 font-medium" title={title}>{title}</span>
      </td>
      <td className="py-3 pr-4 min-w-[220px]">
        <div className="flex flex-wrap gap-1.5">
          {row.reasons.map((r) => (
            <span key={r} className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${CHIP_TONE[r] ?? 'bg-slate-100 text-slate-600'}`}>{attentionReasonLabel(r)}</span>
          ))}
        </div>
        {details.length > 0 && <p className="text-[12px] text-slate-500 mt-1">{details.join(' · ')}</p>}
      </td>
      <td className="py-3 pr-4 whitespace-nowrap text-slate-600">{fmtMs(row.totalMs)}</td>
      <td className="py-3 whitespace-nowrap">
        {row.phoenixTraceUrl ? (
          <a href={row.phoenixTraceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-[12px] font-semibold text-slate-700 hover:bg-slate-50">
            Open in Phoenix <i className="fas fa-arrow-up-right-from-square text-[10px]" />
          </a>
        ) : (
          <span className="text-[12px] text-slate-400">Not sampled in Phoenix</span>
        )}
      </td>
    </tr>
  );
}

export function AttentionTable({ tick }: { tick: number }) {
  const { data, loading, error, reload } = useMonitorData<AttentionPage>((s) => monitorApi.getAttention(null, s), 'attention', tick);
  const [more, setMore] = useState<AttentionPage | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const boundary = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  // A refresh that shifted the first page invalidates the extra pages
  // (rows could be missing between the two); otherwise keep them.
  const firstEnd = data && data.rows.length ? data.rows[data.rows.length - 1].createdAt : null;
  useEffect(() => {
    if (boundary.current !== firstEnd) { setMore(null); setMoreError(false); }
    boundary.current = firstEnd;
  }, [firstEnd]);
  useEffect(() => () => controller.current?.abort(), []);

  const rows = [...(data?.rows ?? []), ...(more?.rows ?? [])];
  const nextBefore = more ? more.nextBefore : data?.nextBefore ?? null;

  const loadMore = async () => {
    if (!nextBefore || moreLoading) return;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setMoreLoading(true); setMoreError(false);
    try {
      const page = await monitorApi.getAttention(nextBefore, c.signal);
      setMore((m) => ({ rows: [...(m?.rows ?? []), ...page.rows], nextBefore: page.nextBefore }));
    } catch (e) {
      if (!isCanceled(e)) setMoreError(true);
    } finally {
      if (!c.signal.aborted) setMoreLoading(false);
    }
  };

  return (
    <SectionCard
      title="Needs attention"
      subtitle="Questions that failed, were not answered, were changed by the answer check, or were slow. Newest first."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && rows.length === 0}
      emptyText="Nothing needs attention right now"
      emptyIcon="fas fa-circle-check"
      onRetry={reload}
    >
      <div className="overflow-x-auto -mx-6 px-6">
        <table className="w-full text-[13px] text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-4 font-semibold">When</th>
              <th className="pb-2 pr-4 font-semibold">Lecture</th>
              <th className="pb-2 pr-4 font-semibold">What happened</th>
              <th className="pb-2 pr-4 font-semibold">Time taken</th>
              <th className="pb-2 font-semibold">Details</th>
            </tr>
          </thead>
          <tbody>{rows.map((r) => <Row key={r.traceId} row={r} />)}</tbody>
        </table>
      </div>
      {moreError && <p className="text-[12px] text-red-600 mt-3">Could not load more. Please try again.</p>}
      {nextBefore && (
        <div className="mt-4 flex justify-center">
          <button type="button" onClick={() => void loadMore()} disabled={moreLoading} className="px-4 py-2 rounded-lg border border-slate-200 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            {moreLoading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </SectionCard>
  );
}
