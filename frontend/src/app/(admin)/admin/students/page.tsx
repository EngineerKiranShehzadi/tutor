'use client';
import { useEffect, useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import { useRouter } from 'next/navigation';
import { useApolloClient, useQuery, useMutation } from '@apollo/client';
import { GET_REGISTERED_STUDENTS } from '@/graphql/analytics.queries';
import { DELETE_USER_MUTATION } from '@/graphql/admin.mutations';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

interface Student {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  questionCount: number;
  status: 'ACTIVE' | 'INACTIVE';
}

const PAGE_SIZE = 10;
// Export pages through the same server API, 100 rows at a time (AD6).
const EXPORT_PAGE = 100;
const EXPORT_MAX = 20_000;

interface StudentPage {
  items: Student[]; total: number; hasMore: boolean;
  totalStudents: number; activeCount: number; inactiveCount: number;
}

const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

/**
 * Students.
 *
 * The page opened with three number cards carrying coloured icon tiles, gave
 * every student an avatar in one of six random colours, and labelled them
 * "Active" or "Inactive" — which here means nothing more than whether they have
 * ever asked a question. Overview says that in words, so this page now does too.
 *
 * Deleting a student is the one thing on this page that cannot be undone:
 * users cascade into chat_sessions, chat_history, student_questions,
 * notifications and rag_answer_memory, so removing a student removes every
 * question they asked from the analytics with them. The confirmation says so,
 * and asks for a tick when there is history to lose.
 */
export default function AdminStudents() {
  const router = useRouter();
  const client = useApolloClient();
  const [deleteUser, { loading: deleting }] = useMutation(DELETE_USER_MUTATION);

  const [searchInput,  setSearchInput]  = useState('');
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page,         setPage]         = useState(1);
  const [deleteId,     setDeleteId]     = useState<string | null>(null);
  const [pageError,    setPageError]    = useState('');
  const [notice,       setNotice]       = useState('');
  const [exporting,    setExporting]    = useState(false);

  // Search and the status filter run on the server; wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const filters = { search: search || null, status: statusFilter === 'ALL' ? null : statusFilter };
  const { data, loading, refetch } = useQuery<{ registeredStudents: StudentPage }>(GET_REGISTERED_STUDENTS, {
    variables: { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters },
    fetchPolicy: 'network-only',
  });

  const result        = data?.registeredStudents;
  const paged         = result?.items ?? [];
  const total         = result?.total ?? 0;
  const totalStudents = result?.totalStudents ?? 0;
  const activeCount   = result?.activeCount ?? 0;
  const inactiveCount = result?.inactiveCount ?? 0;
  const totalPages    = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Deleting the only row on the last page leaves `page` past the end.
  useEffect(() => { if (result && page > totalPages) setPage(totalPages); }, [result, page, totalPages]);

  // Same rule as the Lectures list: a filter that cannot separate anything is
  // not shown at all.
  const pendingStudent = paged.find(s => s.id === deleteId) ?? null;

  const showTabs = activeCount > 0 && inactiveCount > 0;
  const tabs = [
    { key: 'ALL',      label: 'All' },
    { key: 'ACTIVE',   label: 'Have asked a question' },
    { key: 'INACTIVE', label: 'Have not asked yet' },
  ];

  // Every student matching the current filters, fetched page by page.
  const handleExport = async () => {
    setExporting(true); setPageError('');
    try {
      const all: Student[] = [];
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const { data: d } = await client.query<{ registeredStudents: StudentPage }>({
          query: GET_REGISTERED_STUDENTS,
          variables: { limit: EXPORT_PAGE, offset, ...filters },
          fetchPolicy: 'network-only',
        });
        all.push(...d.registeredStudents.items);
        if (!d.registeredStudents.hasMore) break;
      }
      const rows = [['Name', 'Email', 'Questions asked', 'Joined']];
      all.forEach(s => rows.push([
        s.name, s.email, String(s.questionCount), new Date(s.createdAt).toLocaleDateString(),
      ]));
      downloadCsv('students.csv', rows);
    } catch {
      setPageError('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const startDelete = (id: string) => { setDeleteId(id); setPageError(''); setNotice(''); };

  const confirmDelete = async (student: Student) => {
    try {
      await deleteUser({ variables: { id: student.id } });
      setDeleteId(null);
      setNotice(`${student.name} has been deleted.`);
      await refetch();
    } catch (err: unknown) {
      setPageError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'That student could not be deleted.');
      setDeleteId(null);
    }
  };

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        title="Students"
        subtitle="Everyone registered as a student, and how much they have used the tutor."
        action={
          /* Filled, like New Course and New Lecture. That slot holds the
             page's main action, and it looks the same on every page. */
          <button
            onClick={() => { void handleExport(); }}
            disabled={loading || exporting || total === 0}
            className="h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      {notice && (
        <div role="status" className="mb-5 flex items-center gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-circle-check text-[13px] text-[var(--accent)]" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{notice}</p>
        </div>
      )}
      {pageError && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{pageError}</p>
        </div>
      )}

      {showTabs && (
        <div className="flex flex-wrap gap-2 mb-4">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setStatusFilter(t.key); setPage(1); setDeleteId(null); }}
              className={`rounded-control px-3.5 py-2 text-caption font-semibold transition-colors ${
                statusFilter === t.key
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="relative mb-5 max-w-[420px]">
        <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--muted2)]" aria-hidden="true" />
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search by name or email"
          className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] pl-10 pr-4 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
        />
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-[72px] rounded-card border border-[var(--border)] bg-[var(--card)] animate-pulse" />
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">
            {search || statusFilter !== 'ALL' ? 'Nothing matches those filters' : 'No students yet'}
          </p>
          <p className="text-caption text-[var(--muted)] mt-1">
            {search || statusFilter !== 'ALL' ? 'Clear the search or choose a different filter.' : 'Students appear here once they register.'}
          </p>
        </div>
      ) : (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <table className="w-full">
            <thead>
              {/* Lower case, not uppercase and letter-spaced, and no "#"
                  column: that was the row's position, not anything about the
                  student. */}
              <tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                <th className="px-6 py-3 font-medium">Student</th>
                <th className="px-4 py-3 font-medium w-48">Questions asked</th>
                <th className="px-4 py-3 font-medium w-36">Joined</th>
                <th className="px-6 py-3 font-medium w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {paged.map(student => (
                <tr key={student.id}>
                  <td className="px-6 py-4">
                    <p className="text-label font-semibold text-[var(--text)]">{student.name}</p>
                    <p className="text-caption text-[var(--muted)] mt-0.5">{student.email}</p>
                  </td>
                  {/* "Active" and "Inactive" only ever meant "has asked
                      something" or "has not", so the count says it. */}
                  <td className="px-4 py-4 text-label text-[var(--text)] tabular-nums">
                    {student.questionCount > 0
                      ? student.questionCount.toLocaleString()
                      : <span className="text-[var(--muted)]">None yet</span>}
                  </td>
                  <td className="px-4 py-4 text-caption text-[var(--muted)] whitespace-nowrap">
                    {new Date(student.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button onClick={() => router.push(`/admin/students/${student.id}`)} className={outlineBtn}>
                        View
                      </button>
                      <button onClick={() => startDelete(student.id)} className={outlineBtn}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-[var(--border)]">
              <span className="text-caption text-[var(--muted)] tabular-nums">
                Page {page} of {totalPages} · {total.toLocaleString()} {total === 1 ? 'student' : 'students'}
              </span>
              <div className="flex gap-2">
                <button onClick={() => { setPage(p => Math.max(1, p - 1)); setDeleteId(null); }} disabled={page === 1} className={outlineBtn}>
                  Previous
                </button>
                <button onClick={() => { setPage(p => Math.min(totalPages, p + 1)); setDeleteId(null); }} disabled={page === totalPages} className={outlineBtn}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && paged.length > 0 && totalPages === 1 && (
        <p className="text-caption text-[var(--muted)] mt-4 tabular-nums">
          {totalStudents.toLocaleString()} registered · {activeCount.toLocaleString()} have asked a question
        </p>
      )}

      {/* A dialog, not an expanded table row. Expanding the row pushed the
          table apart and left the question sitting under a column heading. */}
      {pendingStudent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(22,26,31,0.45)] p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setDeleteId(null)}
        >
          <div
            className="w-full max-w-[460px] rounded-card border border-[var(--border)] bg-[var(--card)] p-7 shadow-[0_16px_48px_rgba(22,26,31,0.18)]"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-h3 font-semibold text-[var(--text)]">Delete {pendingStudent.name}?</h2>
            <p className="text-label text-[var(--muted)] mt-2 leading-relaxed">
              {pendingStudent.questionCount > 0
                ? `Their ${pendingStudent.questionCount.toLocaleString()} ${pendingStudent.questionCount === 1 ? 'question is' : 'questions are'} deleted too, and they cannot log in again. This cannot be undone.`
                : 'They cannot log in again. This cannot be undone.'}
            </p>
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete(pendingStudent)}
                className="h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete Permanently'}
              </button>
              <button
                type="button"
                onClick={() => setDeleteId(null)}
                className="h-10 rounded-control border border-[var(--border)] px-4 text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
