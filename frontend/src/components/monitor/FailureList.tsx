'use client';
import { monitorApi, type FailureGroup, type MonitorWindow } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';
import Link from 'next/link';
import { attentionDetailLabels } from '@/lib/monitor-labels';

/**
 * What went wrong, grouped.
 *
 * This was a table with a row per failed request: when, lecture, coloured
 * tags, a sentence, a duration, and a column headed "Trace" whose every cell
 * read "Not sampled". Fourteen rows said three things, and the lecture title
 * was long enough to truncate identically on all of them, so the column
 * carried no information at all.
 *
 * It is a list of distinct problems now, each with how many times it
 * happened and when it last did — the way error trackers have shown this for
 * years, because the question is "what is going wrong", not "list every
 * occurrence". The Phoenix link lives on Advanced Traces, which is the page
 * for looking at one request in detail.
 */

function ago(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 90) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? 'an hour ago' : `${hr} hours ago`;
  const days = Math.floor(hr / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** One sentence naming the problem, from the labels the rest of the admin uses. */
function title(g: FailureGroup): string {
  const parts = attentionDetailLabels(g);
  if (parts.length > 0) return parts.join(' · ');
  return g.errored ? 'Something went wrong' : 'The question was not answered';
}

/**
 * One lecture gets named. Several get counted.
 *
 * Listing two titles and then an ellipsis gave a line that was mostly
 * punctuation: these titles run to sixty characters each, so two of them
 * truncated in the middle of the first and told the reader nothing. A count
 * is the honest version, and Content Gaps is where the breakdown lives.
 */
function where(g: FailureGroup): string {
  if (g.lectures === 0) return '';
  if (g.lectures === 1) return g.lectureTitles[0] ?? '1 lecture';
  return `${g.lectures} lectures`;
}

export function FailureList({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<FailureGroup[]>(
    (s) => monitorApi.getFailures(windowKey, s), windowKey, tick);
  const groups = data ?? [];

  return (
    <SectionCard
      title="What went wrong"
      subtitle="Questions the tutor could not answer, most frequent first. Content Gaps lists the questions themselves so you can write the missing material."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && groups.length === 0}
      emptyText="Every question in this period was answered"
      emptyIcon="fas fa-circle-check"
      onRetry={reload}
      headerAction={
        <Link href="/admin/content-gaps" className="text-caption font-semibold text-[var(--accent)] hover:underline whitespace-nowrap">
          Content Gaps
        </Link>
      }
    >
      <ul className="divide-y divide-[var(--border)] -mt-1">
        {groups.map((g, i) => (
          <li key={i} className="flex items-baseline justify-between gap-6 py-3.5 first:pt-0">
            <div className="min-w-0">
              <p className="text-label text-[var(--text)]">{title(g)}</p>
              <p className="text-caption text-[var(--muted)] mt-0.5 truncate">
                {where(g)}
                {where(g) && ' · '}
                last {ago(g.lastAt)}
              </p>
            </div>
            {/* The count is the point of a grouped list, so it is the thing
                the eye lands on at the end of the row. */}
            <p className="shrink-0 text-label text-[var(--text)] tabular-nums">
              {g.occurrences.toLocaleString()}
              <span className="text-caption text-[var(--muted2)]"> {g.occurrences === 1 ? 'time' : 'times'}</span>
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
