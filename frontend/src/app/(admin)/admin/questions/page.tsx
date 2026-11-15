'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApolloClient, useQuery } from '@apollo/client';
import { GET_LECTURE_STATUS_LIST, GET_RECENT_QUESTIONS_PAGE } from '@/graphql/analytics.queries';
import { GET_COURSES } from '@/graphql/course.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnRow } from '@/components/admin/buttons';
import { downloadCsv } from '@/lib/csv';
import { responseStatusLabel, notFoundReasonLabel } from '@/lib/monitor-labels';

interface RecentQuestion {
  id: number;
  studentName: string;
  studentEmail: string;
  lectureId: number;
  lectureTitle: string;
  // Every lecture belongs to exactly one course, so these are never null.
  courseId: number;
  courseTitle: string;
  question: string;
  answer: string;
  // From rag_request_log via chat_history.trace_id. Null on rows recorded
  // before that column existed, which still have a question and an answer.
  traceId: string | null;
  outcome: string | null;
  notFoundReason: string | null;
  createdAt: string;
}

interface QuestionPage { items: RecentQuestion[]; total: number; hasMore: boolean }

// Past this length the answer is clamped with a toggle, so fifteen rows stay
// scannable instead of becoming fifteen essays.
const ANSWER_CLAMP_CHARS = 240;

const PAGE_SIZE = 15;
// Export pages through the same server API, 200 rows at a time.
const EXPORT_PAGE = 200;
const EXPORT_MAX = 20_000;

// Defined once in components/admin/buttons.ts; a local copy here is how the
// same button ended up at two different sizes.
const outlineBtn = btnRow;

/**
 * Questions.
 *
 * A question is a sentence, and sentences do not fit in a table column: the
 * old layout truncated the one thing the page exists to show, behind a "#"
 * column counting rows and a student column repeating the same four names.
 * It is a list now, in the same shape as Recent Questions on Overview, with
 * the question first and everything else under it.
 *
 * It reads chat_history, so every row is a real turn: the question, what the
 * tutor actually replied, and what the outcome was. It used to read
 * student_questions, a second table holding the question alone, which is why
 * two thousand stored answers were never visible anywhere in the admin.
 *
 * One consequence, worth knowing: a question that errored before an answer
 * existed has no chat_history row and is not listed here. Those are in
 * Observability, Errors.
 */
export default function AdminQuestions() {
  const client = useApolloClient();
  const [searchInput,   setSearchInput]   = useState('');
  const [search,        setSearch]        = useState('');
  const [lectureFilter, setLectureFilter] = useState('ALL');
  const [courseFilter,  setCourseFilter]  = useState('ALL');
  const [page,          setPage]          = useState(1);
  const [exporting,     setExporting]     = useState(false);
  const [exportError,   setExportError]   = useState('');
  // Which long answers the reader has opened. Cleared when the page changes,
  // since the ids on screen are different ones.
  const [expanded,      setExpanded]      = useState<Set<number>>(new Set());

  // Search runs on the server; wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const lectureId = lectureFilter === 'ALL' ? null : Number(lectureFilter);
  // Course ids are strings over GraphQL and numbers in the database, so the
  // conversion happens once, here, where the variables are assembled.
  const courseId = courseFilter === 'ALL' ? null : Number(courseFilter);
  const filters = { search: search || null, lectureId, courseId };
  const { data, loading } = useQuery<{ recentQuestionsPage: QuestionPage }>(GET_RECENT_QUESTIONS_PAGE, {
    variables: { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters },
    fetchPolicy: 'network-only',
  });
  const { data: lectureData } = useQuery<{ lectureStatusList: { id: number; title: string }[] }>(GET_LECTURE_STATUS_LIST);
  const { data: courseData } = useQuery<{ courses: { id: string; title: string }[] }>(GET_COURSES, {
    variables: { includeArchived: true },
  });
  const courses = courseData?.courses ?? [];

  const paged = data?.recentQuestionsPage.items ?? [];
  const total = data?.recentQuestionsPage.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lectures = [...(lectureData?.lectureStatusList ?? [])].sort((a, b) => a.title.localeCompare(b.title));
  const filtering = Boolean(search) || lectureFilter !== 'ALL' || courseFilter !== 'ALL';

  const exportCSV = async () => {
    setExporting(true); setExportError('');
    try {
      const all: RecentQuestion[] = [];
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const { data: d } = await client.query<{ recentQuestionsPage: QuestionPage }>({
          query: GET_RECENT_QUESTIONS_PAGE,
          variables: { limit: EXPORT_PAGE, offset, ...filters },
          fetchPolicy: 'network-only',
        });
        all.push(...d.recentQuestionsPage.items);
        if (!d.recentQuestionsPage.hasMore) break;
      }
      // The answer and the outcome go in the file too. An export of questions
      // without the replies is not a record anyone can review.
      const rows = [['Student', 'Email', 'Course', 'Lecture', 'Question', 'Answer', 'Outcome', 'Asked']];
      all.forEach(q => rows.push([
        q.studentName, q.studentEmail, q.courseTitle, q.lectureTitle, q.question, q.answer,
        q.outcome ? responseStatusLabel(q.outcome) : '',
        new Date(q.createdAt).toLocaleString(),
      ]));
      downloadCsv('questions.csv', rows);
    } catch {
      setExportError('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-[1180px]">
      {/* Titled "Questions", the same word the sidebar uses. */}
      <AdminPageHero
        title="Questions"
        subtitle="Every question the tutor answered, with its reply, newest first. Questions that failed before an answer are under Observability, Errors."
        action={
          <button
            onClick={() => { void exportCSV(); }}
            disabled={loading || exporting || total === 0}
            className="h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      {exportError && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{exportError}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[260px]">
          <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--muted2)]" aria-hidden="true" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search a question or a student name"
            className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] pl-10 pr-4 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
          />
        </div>
        {/* Course before lecture, widest scope first. Both can be set: that is
            simply a narrower query, and a lecture outside the chosen course
            correctly returns nothing rather than quietly ignoring one. */}
        <div className="relative">
          <select
            aria-label="Filter by course"
            value={courseFilter}
            onChange={e => { setCourseFilter(e.target.value); setPage(1); }}
            className="appearance-none rounded-control border border-[var(--border)] bg-[var(--card)] pl-3.5 pr-10 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] max-w-[260px]"
          >
            <option value="ALL">All courses</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <i className="fas fa-chevron-down pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11px] text-[var(--muted2)]" aria-hidden="true" />
        </div>
        <div className="relative">
          <select
            aria-label="Filter by lecture"
            value={lectureFilter}
            onChange={e => { setLectureFilter(e.target.value); setPage(1); }}
            className="appearance-none rounded-control border border-[var(--border)] bg-[var(--card)] pl-3.5 pr-10 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] max-w-[260px]"
          >
            <option value="ALL">All lectures</option>
            {lectures.map(l => <option key={l.id} value={String(l.id)}>{l.title}</option>)}
          </select>
          <i className="fas fa-chevron-down pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--muted)]" aria-hidden="true" />
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-[76px] rounded-card border border-[var(--border)] bg-[var(--card)] animate-pulse" />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">
            {filtering ? 'Nothing matches those filters' : 'No questions yet'}
          </p>
          <p className="text-caption text-[var(--muted)] mt-1">
            {filtering ? 'Clear the search or choose a different lecture.' : 'Questions appear here as students use the tutor.'}
          </p>
        </div>
      ) : (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] px-6">
          {/* The question is the content, so it comes first and is never cut
              off. Who asked it and where is the line underneath. */}
          <ul className="divide-y divide-[var(--border)]">
            {paged.map(q => (
              <li key={q.id} className="py-4">
                <p className="text-label text-[var(--text)] leading-relaxed">{q.question}</p>

                {/* The reply, indented under the question it answers. A left
                    rule rather than a tinted box: this is a transcript, and a
                    card around every answer would turn fifteen turns into
                    fifteen boxes. */}
                <div className="mt-2 border-l-2 border-[var(--border)] pl-3">
                  <p className={`text-label text-[var(--muted)] leading-relaxed whitespace-pre-wrap ${
                    expanded.has(q.id) || q.answer.length <= ANSWER_CLAMP_CHARS ? '' : 'line-clamp-3'
                  }`}>
                    {q.answer}
                  </p>
                  {q.answer.length > ANSWER_CLAMP_CHARS && (
                    <button
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev);
                        if (next.has(q.id)) next.delete(q.id); else next.add(q.id);
                        return next;
                      })}
                      className="mt-1 text-caption font-semibold text-[var(--accent)] hover:underline"
                    >
                      {expanded.has(q.id) ? 'Show less' : 'Show full answer'}
                    </button>
                  )}
                </div>

                <p className="text-caption text-[var(--muted)] mt-1.5">
                  {/* No link to the student: recentQuestionsPage returns the
                      name and email but not the id the student page needs. */}
                  <span title={q.studentEmail}>{q.studentName}</span>
                  {' · '}
                  <Link href={`/admin/lectures/${q.lectureId}`} className="hover:underline">
                    {q.lectureTitle}
                  </Link>
                  {' · '}
                  {new Date(q.createdAt).toLocaleString(undefined, {
                    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                  {/* Outcome and trace only when the row has them. Older rows
                      predate chat_history.trace_id, and printing "Unknown
                      outcome" on two thousand of them would be noise, not
                      information. */}
                  {q.outcome && (
                    <>
                      {' · '}
                      {/* The outcome is the one part of this line an admin
                          scans for, so it steps out of the muted run of text
                          rather than reading as part of the sentence. Same
                          rule as System Health: gold is reserved for the state
                          a human may need to act on, and an answered turn is
                          not one. */}
                      <span className={q.outcome.includes('NOT_FOUND')
                        ? 'font-semibold text-[var(--gold)]'
                        : 'font-medium text-[var(--text)]'}>
                        {responseStatusLabel(q.outcome)}
                        {q.notFoundReason ? ` (${notFoundReasonLabel(q.notFoundReason)})` : ''}
                      </span>
                    </>
                  )}
                  {q.traceId && (
                    <>
                      {' · '}
                      <Link
                        href={`/admin/rag-traces/traces/${encodeURIComponent(q.traceId)}?from=questions`}
                        className="text-[var(--accent)] hover:underline"
                      >
                        View trace
                      </Link>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-4 py-4 border-t border-[var(--border)]">
            <span className="text-caption text-[var(--muted)] tabular-nums">
              {totalPages > 1 ? `Page ${page} of ${totalPages} · ` : ''}
              {total.toLocaleString()} {total === 1 ? 'question' : 'questions'}{filtering ? ' matching' : ''}
            </span>
            {totalPages > 1 && (
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className={outlineBtn}>
                  Previous
                </button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className={outlineBtn}>
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
