'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@apollo/client';
import { GET_CONTENT_GAPS } from '@/graphql/analytics.queries';
import { GET_COURSES } from '@/graphql/course.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnRow, filterOn, filterOff } from '@/components/admin/buttons';

interface MissedQuestion { question: string; askedCount: number; lastAskedAt: string }

// Course ids are strings over GraphQL and numbers in the database, so the
// filter holds the string and converts once, where it is sent.
interface AdminCourse { id: string; title: string }

interface LectureGap {
  lectureId:         number;
  lectureTitle:      string;
  // Every lecture belongs to exactly one course, so these are never null.
  courseId:          number;
  courseTitle:       string;
  questionsAsked:    number;
  questionsAnalysed: number;
  unanswered:        number;
  questionsToAnswer: number;
  missingMaterial:   number;
  offTopic:          number;
  noMaterial:        number;
  status:            string;
  windowDays:        number;
  missedQuestions:   MissedQuestion[];
}

const n = (x: number) => x.toLocaleString();

// Matches CONTENT_GAPS_WINDOWS on the server. The ranges reports like this
// normally offer: a week, a month, a quarter, half a year, a year.
const WINDOWS: { days: number; label: string }[] = [
  { days: 7,   label: 'Last 7 days' },
  { days: 30,  label: 'Last 30 days' },
  { days: 90,  label: 'Last 90 days' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last 12 months' },
];
// The server returns at most this many distinct questions for one lecture.
const PER_LECTURE_CAP = 20;

/**
 * Content Gaps.
 *
 * One job: the questions students asked that the material could not answer,
 * so the next upload writes itself.
 *
 * Everything else on this page is a qualification, and qualifications are
 * kept below the answer, not beside it. The counts live on the filter rather
 * than being repeated in a sentence above it; the period is a control rather
 * than words inside that sentence; and how many questions were off topic or
 * too old to judge is a footnote under the list, because on a row it reads
 * as a second problem with that lecture when it is nothing of the kind.
 */
export default function AdminContentGaps() {
  const [days, setDays] = useState(90);
  const [courseFilter, setCourseFilter] = useState('');
  const { data: courseData } = useQuery<{ courses: AdminCourse[] }>(GET_COURSES, {
    variables: { includeArchived: true },
  });
  const courses = courseData?.courses ?? [];
  // Filtered on the server, not here: the counts per lecture are computed by
  // the query, so narrowing the returned rows in the browser would leave the
  // totals describing courses that are no longer on screen.
  const { data, loading, error } = useQuery<{ contentGaps: LectureGap[] }>(GET_CONTENT_GAPS, {
    variables: { days, courseId: courseFilter ? Number(courseFilter) : null },
    fetchPolicy: 'network-only',
  });
  const [open, setOpen] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [explain, setExplain] = useState(false);

  const gaps = data?.contentGaps ?? [];
  const needing = gaps.filter(g => g.questionsToAnswer > 0);
  const shown = showAll ? gaps : needing;

  const tab = (active: boolean) => (active ? filterOn : filterOff);

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        title="Content Gaps"
        subtitle="Questions students asked that the lecture material could not answer."
        action={
          <div className="flex items-center gap-3">
          {/* Course first: it is the wider scope, and it reads left to right
              as "this course, over this period". Neutral colours, because the
              period is the control this page is really about. */}
          <div className="relative">
            <select
              aria-label="Course"
              value={courseFilter}
              onChange={e => { setCourseFilter(e.target.value); setOpen(null); }}
              className="h-10 appearance-none cursor-pointer rounded-control border border-[var(--border)] bg-[var(--card)] pl-4 pr-10 text-label font-semibold text-[var(--text)] outline-none transition-colors hover:bg-[var(--surface)]"
            >
              <option value="">All courses</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <i className="fas fa-chevron-down pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11px] text-[var(--muted2)]" aria-hidden="true" />
          </div>
          {/* The period is a control, in the place every other admin page puts
             its controls. A dropdown rather than a row of buttons: five
             ranges is more than a toggle should carry. */}
          <div className="relative">
            <select
              aria-label="Period"
              value={days}
              onChange={e => { setDays(Number(e.target.value)); setOpen(null); }}
              /* The accent, like every other control in a page heading. The
                 options themselves are drawn by the browser, so they are set
                 back to the page colours or they inherit white on navy. */
              className="h-10 appearance-none cursor-pointer rounded-control border border-[var(--accent)] bg-[var(--accent)] pl-4 pr-10 text-label font-semibold text-white outline-none transition-colors hover:bg-[var(--accent-deep)] hover:border-[var(--accent-deep)] [&>option]:bg-[var(--card)] [&>option]:text-[var(--text)] [&>option]:font-medium"
            >
              {WINDOWS.map(w => <option key={w.days} value={w.days}>{w.label}</option>)}
            </select>
            <i className="fas fa-chevron-down pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11px] text-white/80" aria-hidden="true" />
          </div>
          </div>
        }
      />

      {error ? (
        <div role="alert" className="flex items-start gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">This report could not be loaded. Try again in a moment.</p>
        </div>
      ) : loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-[72px] rounded-card border border-[var(--border)] bg-[var(--card)] animate-pulse" />)}
        </div>
      ) : gaps.length === 0 ? (
        <p className="text-label text-[var(--muted)]">
          No questions were asked in this period, so there is nothing to report.
        </p>
      ) : (
        <>
          {/* The counts live here and nowhere else. A sentence above saying
              the same numbers was the thing that read as clutter. */}
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => { setShowAll(false); setOpen(null); }} className={tab(!showAll)}>
              Needs Material
              <span className={`ml-1 tabular-nums font-medium ${!showAll ? 'text-white/70' : 'text-[var(--accent-dim)]'}`}>({needing.length})</span>
            </button>
            <button onClick={() => { setShowAll(true); setOpen(null); }} className={tab(showAll)}>
              All Lectures
              <span className={`ml-1 tabular-nums font-medium ${showAll ? 'text-white/70' : 'text-[var(--accent-dim)]'}`}>({gaps.length})</span>
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="text-label text-[var(--muted)]">
              Every question in this period was answered from its own lecture.
            </p>
          ) : (
            <div className="rounded-card border border-[var(--border)] bg-[var(--card)] overflow-hidden">
              <ul className="divide-y divide-[var(--border)]">
                {shown.map(g => {
                  const expanded = open === g.lectureId;
                  const hasQuestions = g.missedQuestions.length > 0;
                  return (
                    <li key={g.lectureId}>
                      <div className="flex items-start gap-4 px-6 py-4">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/admin/lectures/${g.lectureId}`}
                            className="text-label font-semibold text-[var(--text)] hover:underline"
                          >
                            {g.lectureTitle}
                          </Link>
                          {/* Which course this lecture belongs to, shown only
                              when there is more than one. With a single course
                              it would repeat the same words on every row. */}
                          {courses.length > 1 && (
                            <p className="text-caption text-[var(--muted2)] mt-0.5">{g.courseTitle}</p>
                          )}
                          {/* One fact about this lecture, then the size of the
                              question pool it came out of. Nothing else. */}
                          <p className="text-caption text-[var(--muted)] mt-1">
                            {g.questionsToAnswer > 0
                              ? <span className="text-[var(--gold)] font-medium">
                                  {n(g.questionsToAnswer)} {g.questionsToAnswer === 1 ? 'unanswered question' : 'unanswered questions'}
                                </span>
                              : <span>No unanswered questions</span>}
                            {' · '}{n(g.questionsAsked)} asked
                          </p>
                        </div>
                        {hasQuestions && (
                          <button
                            onClick={() => setOpen(expanded ? null : g.lectureId)}
                            aria-expanded={expanded}
                            className={`shrink-0 ${btnRow}`}
                          >
                            {expanded ? 'Hide Questions' : 'See Questions'}
                          </button>
                        )}
                      </div>

                      {expanded && hasQuestions && (
                        /* The questions themselves, most asked first. This is
                           the page's actual output: what to write. */
                        <ul className="border-t border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
                          {g.missedQuestions.map((m, i) => (
                            <li key={i} className="px-6 py-3.5">
                              <p className="text-label text-[var(--text)] leading-relaxed">{m.question}</p>
                              <p className="text-caption text-[var(--muted)] mt-1">
                                {m.askedCount > 1 ? `Asked by ${n(m.askedCount)} students` : 'Asked once'}
                                {' · last on '}
                                {new Date(m.lastAskedAt).toLocaleDateString(undefined, {
                                  day: 'numeric', month: 'short', year: 'numeric',
                                })}
                              </p>
                            </li>
                          ))}
                          {g.questionsToAnswer > PER_LECTURE_CAP && (
                            <li className="px-6 py-3 text-caption text-[var(--muted)]">
                              Showing the {PER_LECTURE_CAP} most asked of {n(g.questionsToAnswer)}.
                            </li>
                          )}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* A footnote, under what it qualifies, and closed until asked for.
              Every number here is given against the total it came out of:
              a bare "7 questions" refers to nothing the reader can see. */}
          <div className="mt-4">
            <button
              onClick={() => setExplain(v => !v)}
              aria-expanded={explain}
              className="text-caption font-semibold text-[var(--accent)] hover:underline"
            >
              {explain ? 'Hide' : 'How this is measured'}
            </button>
            {explain && (
              /* How it works, and nothing else. No figures: an explanation
                 that recites numbers has to be re-read every time one of them
                 moves, and the method never moves. */
              <div className="text-caption text-[var(--muted)] leading-relaxed mt-2 max-w-[80ch] space-y-1.5">
                <p>
                  The tutor records what it did with every question it was asked.
                </p>
                <p>
                  A question is listed here when the tutor searched its lecture, found related material,
                  and none of it was close enough to answer from. That is the gap an upload closes.
                </p>
                <p>
                  Two kinds are left out. A question that matched nothing in its lecture was about something
                  the lecture never set out to cover. A question asked before the tutor began recording
                  outcomes cannot be judged either way.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
