'use client';
import Link from 'next/link';
import { useQuery } from '@apollo/client';
import {
  GET_ANALYTICS_SUMMARY,
  GET_QUESTIONS_PER_LECTURE,
  GET_RECENT_QUESTIONS,
  GET_REGISTERED_STUDENTS,
} from '@/graphql/analytics.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

/**
 * Overview.
 *
 * This page used to open with four large number cards, then draw the
 * questions-per-lecture figures twice — once as a vertical bar chart in six
 * rotating colours, once as a list of bars underneath it — and state student
 * engagement three ways in a single strip. A lot of room for four small
 * integers, and nothing on it said whether anything needed doing.
 *
 * It is now ordered by what an administrator comes here to find out: the size
 * of things, then anything that needs attention, then what students are
 * actually asking. The per-lecture figures are drawn once, horizontally, so a
 * full lecture title can be read instead of truncated under a bar.
 */

type LectureCount = { lectureId: number; lectureTitle: string; count: number };
type RecentQuestion = {
  id: number; studentName: string; lectureTitle: string; question: string; createdAt: string;
};

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-control bg-[var(--surface)] ${className}`} />;
}

export default function AdminDashboard() {
  const { data: summaryData, loading: summaryLoading } = useQuery(GET_ANALYTICS_SUMMARY, { fetchPolicy: 'cache-and-network' });
  const { data: perLecture, loading: perLectureLoading } = useQuery(GET_QUESTIONS_PER_LECTURE, { fetchPolicy: 'cache-and-network' });
  const { data: recentData, loading: recentLoading } = useQuery(GET_RECENT_QUESTIONS, { variables: { limit: 10 }, fetchPolicy: 'cache-and-network' });

  // Only the summary counts are needed here; the list itself is paged (AD6).
  const { data: studentsData } = useQuery(GET_REGISTERED_STUDENTS, { variables: { limit: 1, offset: 0 }, fetchPolicy: 'cache-and-network' });

  const summary     = summaryData?.analyticsSummary;
  const qPerLecture: LectureCount[] = perLecture?.questionsPerLecture ?? [];
  const recent: RecentQuestion[]    = recentData?.recentQuestions ?? [];

  const studentTotals: { totalStudents: number; activeCount: number; inactiveCount: number } | undefined = studentsData?.registeredStudents;
  const totalStudents = studentTotals?.totalStudents ?? 0;
  const activeCount   = studentTotals?.activeCount ?? 0;

  const totalLectures  = summary?.totalLectures ?? 0;
  const readyAgents    = summary?.readyAgents ?? 0;
  const totalQuestions = summary?.totalQuestions ?? 0;

  // Both derived from figures already on the page, so they cannot disagree
  // with the numbers above them.
  const notReady    = Math.max(totalLectures - readyAgents, 0);
  const unasked     = Math.max(totalLectures - qPerLecture.length, 0);
  const maxCount    = qPerLecture.reduce((m, l) => Math.max(m, l.count), 0);
  const askedTotal  = qPerLecture.reduce((s, l) => s + l.count, 0);

  // Each figure carries the same icon as the sidebar item it belongs to, so the
  // mark is a pointer to a place in the product rather than decoration.
  const stats = [
    { icon: 'fas fa-user-graduate', label: 'Students',  value: totalStudents,  note: `${activeCount} have asked a question` },
    { icon: 'fas fa-play-circle',   label: 'Lectures',  value: totalLectures,  note: `${readyAgents} with a tutor ready` },
    { icon: 'fas fa-comments',      label: 'Questions', value: totalQuestions, note: 'asked in total' },
  ];

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        icon="fas fa-chart-pie"
        title="Overview"
        subtitle="Where the course stands today, and what students are asking."
      />

      {/* One strip, three figures, divided — rather than four cards each large
          enough to hold a headline. The second line gives each number the
          context that made the old "Live" pills look like information. */}
      <section className="rounded-card border border-[var(--border)] bg-[var(--card)] divide-x divide-[var(--border)] grid grid-cols-3 mb-5">
        {stats.map(({ icon, label, value, note }) => (
          <div key={label} className="px-6 py-5">
            <p className="flex items-center gap-2 text-caption font-medium text-[var(--muted)]">
              <i className={`${icon} text-[12px] text-[var(--muted2)]`} aria-hidden="true" />
              {label}
            </p>
            {(summaryLoading && !summaryData) ? (
              <Skeleton className="h-8 w-14 mt-2" />
            ) : (
              <p className="text-h2 font-semibold text-[var(--text)] leading-none mt-2 tabular-nums">{value}</p>
            )}
            <p className="text-caption text-[var(--muted)] mt-2">{note}</p>
          </div>
        ))}
      </section>

      {/* Shown only when there is something to do. An empty "all clear" panel
          would take the same room to say nothing. */}
      {(!summaryLoading || !!summaryData) && (notReady > 0 || unasked > 0) && (
        <section className="rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] bg-[var(--card)] px-5 py-4 mb-5">
          <h2 className="flex items-center gap-2 text-label font-semibold text-[var(--text)]">
            <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)]" aria-hidden="true" />
            Needs Attention
          </h2>
          <ul className="mt-2 space-y-1.5">
            {notReady > 0 && (
              <li className="flex flex-wrap items-center gap-x-2 text-label text-[var(--text)]">
                <span>
                  {notReady} {notReady === 1 ? 'lecture has' : 'lectures have'} no tutor ready, so students cannot ask about {notReady === 1 ? 'it' : 'them'}.
                </span>
                <Link href="/admin/lectures" className="font-semibold text-[var(--accent)] hover:underline">Open Lectures</Link>
              </li>
            )}
            {unasked > 0 && (
              <li className="flex flex-wrap items-center gap-x-2 text-label text-[var(--text)]">
                <span>{unasked} {unasked === 1 ? 'lecture has' : 'lectures have'} had no questions yet.</span>
                <Link href="/admin/content-gaps" className="font-semibold text-[var(--accent)] hover:underline">Open Content Gaps</Link>
              </li>
            )}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        {/* Drawn once, horizontally: a lecture title is a sentence, and under a
            vertical bar it had to be cut to fourteen characters. */}
        <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6">
          <div className="flex items-baseline justify-between gap-4 mb-5">
            <div>
              <h2 className="text-h3 font-semibold text-[var(--text)]">Questions per Lecture</h2>
              <p className="text-caption text-[var(--muted)] mt-0.5">Every student, since the course opened</p>
            </div>
            {(!perLectureLoading || !!perLecture) && qPerLecture.length > 0 && (
              <p className="text-caption text-[var(--muted)] shrink-0 tabular-nums">{askedTotal} in total</p>
            )}
          </div>

          {(perLectureLoading && !perLecture) ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : qPerLecture.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-label font-semibold text-[var(--text)]">No questions yet</p>
              <p className="text-caption text-[var(--muted)] mt-1">This fills in as students use the tutor.</p>
            </div>
          ) : (
            <ol className="space-y-3.5">
              {[...qPerLecture].sort((a, b) => b.count - a.count).map(item => (
                <li key={item.lectureId}>
                  <div className="flex items-baseline justify-between gap-4 mb-1.5">
                    <p className="text-label text-[var(--text)] truncate" title={item.lectureTitle}>{item.lectureTitle}</p>
                    <span className="text-label font-semibold text-[var(--text)] shrink-0 tabular-nums">{item.count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${maxCount ? Math.max(Math.round((item.count / maxCount) * 100), 2) : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* A list separated by rules, not a stack of tinted cards: ten boxes
            inside a box was the heaviest thing on the page. */}
        <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6">
          {/* The link sits beside the heading, in the same place and at the same
              size as "in total" on the chart card, so both card headers read
              the same way. */}
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <div>
              <h2 className="text-h3 font-semibold text-[var(--text)]">Recent Questions</h2>
              <p className="text-caption text-[var(--muted)] mt-0.5">The newest first</p>
            </div>
            <Link
              href="/admin/questions"
              className="shrink-0 text-caption font-semibold text-[var(--accent)] hover:underline"
            >
              View all
            </Link>
          </div>

          {(recentLoading && !recentData) ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : recent.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-label font-semibold text-[var(--text)]">Nothing asked yet</p>
              <p className="text-caption text-[var(--muted)] mt-1">Questions appear here as they come in.</p>
            </div>
          ) : (
            // Scrolls inside the card so its height stays level with the chart
            // beside it. The questions are separated by space, not rules: a rule
            // between items lands directly under the heading as soon as the list
            // is scrolled, which reads as a border that comes and goes.
            <ul className="space-y-4 max-h-[420px] overflow-y-auto pr-2">
              {recent.slice(0, 10).map(q => (
                <li key={q.id}>
                  <p className="text-label text-[var(--text)] leading-relaxed line-clamp-2">{q.question}</p>
                  <p className="text-caption text-[var(--muted)] mt-1.5 truncate">
                    {q.studentName} · {q.lectureTitle} · {new Date(q.createdAt).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
