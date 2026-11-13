'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApolloClient, useQuery } from '@apollo/client';
import { GET_LECTURE_STATUS_LIST, GET_RECENT_QUESTIONS_PAGE } from '@/graphql/analytics.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { downloadCsv } from '@/lib/csv';

interface RecentQuestion {
  id: number;
  studentName: string;
  studentEmail: string;
  lectureId: number;
  lectureTitle: string;
  question: string;
  createdAt: string;
}

interface QuestionPage { items: RecentQuestion[]; total: number; hasMore: boolean }

const PAGE_SIZE = 15;
// Export pages through the same server API, 200 rows at a time.
const EXPORT_PAGE = 200;
const EXPORT_MAX = 20_000;

const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

/**
 * Questions.
 *
 * A question is a sentence, and sentences do not fit in a table column: the
 * old layout truncated the one thing the page exists to show, behind a "#"
 * column counting rows and a student column repeating the same four names.
 * It is a list now, in the same shape as Recent Questions on Overview, with
 * the question first and everything else under it.
 *
 * student_questions holds the question only, so the tutor's answer cannot be
 * shown here; it lives in chat_history and is reached through Tutor Monitor.
 */
export default function AdminQuestions() {
  const client = useApolloClient();
  const [searchInput,   setSearchInput]   = useState('');
  const [search,        setSearch]        = useState('');
  const [lectureFilter, setLectureFilter] = useState('ALL');
  const [page,          setPage]          = useState(1);
  const [exporting,     setExporting]     = useState(false);
  const [exportError,   setExportError]   = useState('');

  // Search runs on the server; wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const lectureId = lectureFilter === 'ALL' ? null : Number(lectureFilter);
  const filters = { search: search || null, lectureId };
  const { data, loading } = useQuery<{ recentQuestionsPage: QuestionPage }>(GET_RECENT_QUESTIONS_PAGE, {
    variables: { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters },
    fetchPolicy: 'cache-and-network',
  });
  const { data: lectureData } = useQuery<{ lectureStatusList: { id: number; title: string }[] }>(GET_LECTURE_STATUS_LIST);

  const paged = data?.recentQuestionsPage.items ?? [];
  const total = data?.recentQuestionsPage.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lectures = [...(lectureData?.lectureStatusList ?? [])].sort((a, b) => a.title.localeCompare(b.title));
  const filtering = Boolean(search) || lectureFilter !== 'ALL';

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
      const rows = [['Student', 'Email', 'Lecture', 'Question', 'Asked']];
      all.forEach(q => rows.push([
        q.studentName, q.studentEmail, q.lectureTitle, q.question,
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
        subtitle="Everything students have asked the tutor, newest first."
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
