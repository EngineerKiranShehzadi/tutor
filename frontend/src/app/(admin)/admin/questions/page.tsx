'use client';
import { useEffect, useState } from 'react';
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

const PAGE_SIZE = 10;
// Export pages through the same server API, 200 rows at a time.
const EXPORT_PAGE = 200;
const EXPORT_MAX = 20_000;

// Page buttons around the current one, with the first and last always shown.
function pageWindow(page: number, total: number): (number | '…')[] {
  const pages = new Set([1, total, page - 2, page - 1, page, page + 1, page + 2].filter(p => p >= 1 && p <= total));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  sorted.forEach((p, i) => { if (i > 0 && p - sorted[i - 1] > 1) out.push('…'); out.push(p); });
  return out;
}

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
    fetchPolicy: 'network-only',
  });
  const { data: lectureData } = useQuery<{ lectureStatusList: { id: number; title: string }[] }>(GET_LECTURE_STATUS_LIST);

  const paged = data?.recentQuestionsPage.items ?? [];
  const total = data?.recentQuestionsPage.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lectures = [...(lectureData?.lectureStatusList ?? [])].sort((a, b) => a.title.localeCompare(b.title));
  const filtering = !!search || lectureFilter !== 'ALL';

  const handleLecture = (val: string) => { setLectureFilter(val); setPage(1); };

  // Every question matching the current filters, fetched page by page.
  const exportCSV = async () => {
    setExporting(true); setExportError('');
    try {
      const rows: unknown[][] = [['Student', 'Email', 'Lecture', 'Question', 'Date']];
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const { data: d } = await client.query<{ recentQuestionsPage: QuestionPage }>({
          query: GET_RECENT_QUESTIONS_PAGE,
          variables: { limit: EXPORT_PAGE, offset, ...filters },
          fetchPolicy: 'network-only',
        });
        d.recentQuestionsPage.items.forEach(q =>
          rows.push([q.studentName, q.studentEmail, q.lectureTitle, q.question, new Date(q.createdAt).toLocaleString()]));
        if (!d.recentQuestionsPage.hasMore) break;
      }
      downloadCsv('student-questions.csv', rows);
    } catch {
      setExportError('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-comments"
        iconGradient="from-amber-500 to-orange-600"
        title="Student Questions"
        subtitle={loading && !data ? 'Loading…' : `${total} question${total !== 1 ? 's' : ''}${filtering ? ' match' : ' asked'}`}
        action={
          <button
            onClick={() => { void exportCSV(); }}
            disabled={loading || exporting || total === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[14px] font-semibold hover:bg-white/25 transition-all disabled:opacity-40"
          >
            <i className={`fas ${exporting ? 'fa-spinner fa-spin' : 'fa-download'} text-[12px]`} /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[13px]" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search by question or student name…"
            className="w-full pl-9 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <select
          value={lectureFilter}
          onChange={e => handleLecture(e.target.value)}
          className="px-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 transition-all min-w-[180px]"
        >
          <option value="ALL">All lectures</option>
          {lectures.map(l => <option key={l.id} value={String(l.id)}>{l.title}</option>)}
        </select>
      </div>

      {exportError && <p className="text-[14px] text-red-600 mb-3">{exportError}</p>}

      {loading && !data ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-4 px-6 py-5 border-b border-slate-100 last:border-0">
              <div className="space-y-2 w-32 shrink-0">
                <div className="h-4 bg-slate-100 rounded animate-pulse" />
                <div className="h-3.5 bg-slate-100 rounded animate-pulse" />
              </div>
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 bg-slate-100 rounded animate-pulse" />
                <div className="h-3.5 bg-slate-100 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : total === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-comments text-2xl text-slate-400" />
          </div>
          <p className="text-[17px] font-semibold text-slate-600">
            {filtering ? 'No matching questions' : 'No questions yet'}
          </p>
          <p className="text-[14px] mt-1">
            {filtering ? 'Try adjusting your filters.' : 'Questions asked by students via the AI tutor will appear here.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-10">#</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-44">Student</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-48">Lecture</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Question</th>
                <th className="text-left px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-36">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.map((q, i) => (
                <tr key={q.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-4 text-[13px] text-slate-400 tabular-nums">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-[12px] font-bold shrink-0">
                        {q.studentName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-slate-800 truncate">{q.studentName}</p>
                        <p className="text-[12px] text-slate-400 truncate">{q.studentEmail}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="inline-block max-w-[180px] text-[13px] text-slate-600 bg-slate-100 px-2.5 py-1 rounded-lg font-medium truncate">
                      {q.lectureTitle}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-[15px] text-slate-700 line-clamp-2 leading-relaxed max-w-lg">{q.question}</p>
                  </td>
                  <td className="px-6 py-4 text-[13px] text-slate-400 whitespace-nowrap">
                    {new Date(q.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/50 flex flex-col items-center gap-2">
            <span className="text-[13px] text-slate-400">{total} question{total !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[12px]">
                  <i className="fas fa-chevron-left" />
                </button>
                {pageWindow(page, totalPages).map((p, i) => p === '…' ? (
                  <span key={`gap-${i}`} className="w-8 text-center text-slate-400 text-[13px]">…</span>
                ) : (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded-lg text-[13px] font-semibold border transition-colors ${p === page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[12px]">
                  <i className="fas fa-chevron-right" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
