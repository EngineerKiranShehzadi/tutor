'use client';
import Link from 'next/link';
import { monitorApi, type LectureStats, type MonitorWindow } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtPct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const NOT_FOUND_WARN = 0.3;

export function LectureTable({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<LectureStats[]>((s) => monitorApi.getLectures(windowKey, s), windowKey, tick);
  return (
    <SectionCard
      title="By lecture"
      subtitle="Lectures with the most unanswered questions come first."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && data.length === 0}
      emptyText="No questions were asked in this period"
      emptyIcon="fas fa-book-open"
      onRetry={reload}
    >
      <div className="overflow-x-auto -mx-6 px-6">
        <table className="w-full text-[13px] text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-4 font-semibold">Lecture</th>
              <th className="pb-2 pr-4 font-semibold text-right">Questions</th>
              <th className="pb-2 pr-4 font-semibold text-right">Answered</th>
              <th className="pb-2 pr-4 font-semibold text-right">Not found</th>
              <th className="pb-2 font-semibold text-right">Typical response time</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((l) => {
              const warn = (l.notFoundRate ?? 0) > NOT_FOUND_WARN;
              return (
                <tr key={l.lectureId} className="border-t border-slate-100">
                  <td className="py-3 pr-4 max-w-[260px]">
                    <Link href={`/admin/lectures/${l.lectureId}`} title={l.title} className="block truncate font-medium text-indigo-600 hover:underline">{l.title}</Link>
                  </td>
                  <td className="py-3 pr-4 text-right text-slate-700 tabular-nums">{l.requests.toLocaleString()}</td>
                  <td className="py-3 pr-4 text-right text-slate-700 tabular-nums">{fmtPct(l.answeredRate)}</td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">
                    <span className={`tabular-nums ${warn ? 'px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold' : 'text-slate-700'}`}>{fmtPct(l.notFoundRate)}</span>
                  </td>
                  <td className="py-3 text-right text-slate-700 tabular-nums whitespace-nowrap">{l.p50Ms === null ? '—' : fmtMs(l.p50Ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
