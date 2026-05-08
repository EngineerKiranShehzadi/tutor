'use client';
import { useState } from 'react';
import { useQuery } from '@apollo/client';
import { GET_RECENT_QUESTIONS } from '@/graphql/analytics.queries';

interface RecentQuestion {
  id: number;
  studentName: string;
  studentEmail: string;
  lectureTitle: string;
  question: string;
  createdAt: string;
}

const PAGE_SIZE = 10;

function exportCSV(questions: RecentQuestion[]) {
  const rows = [['Student', 'Email', 'Lecture', 'Question', 'Date']];
  questions.forEach(q =>
    rows.push([q.studentName, q.studentEmail, q.lectureTitle, q.question, new Date(q.createdAt).toLocaleString()])
  );
  const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'student-questions.csv';
  a.click();
}

export default function AdminQuestions() {
  const { data, loading } = useQuery(GET_RECENT_QUESTIONS, { fetchPolicy: 'network-only' });
  const questions: RecentQuestion[] = data?.recentQuestions ?? [];

  const [search,        setSearch]        = useState('');
  const [lectureFilter, setLectureFilter] = useState('ALL');
  const [page,          setPage]          = useState(1);

  const lectures = Array.from(new Set(questions.map(q => q.lectureTitle))).sort();

  const filtered = questions.filter(q => {
    const matchSearch  = !search || q.question.toLowerCase().includes(search.toLowerCase()) || q.studentName.toLowerCase().includes(search.toLowerCase());
    const matchLecture = lectureFilter === 'ALL' || q.lectureTitle === lectureFilter;
    return matchSearch && matchLecture;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleSearch = (val: string) => { setSearch(val); setPage(1); };
  const handleLecture = (val: string) => { setLectureFilter(val); setPage(1); };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900">Student Questions</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading ? 'Loading…' : `${questions.length} question${questions.length !== 1 ? 's' : ''} asked`}
          </p>
        </div>
        <button
          onClick={() => exportCSV(filtered)}
          disabled={loading || filtered.length === 0}
          className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] font-semibold text-slate-600 hover:bg-slate-50 shadow-sm transition-colors disabled:opacity-40"
        >
          <i className="fas fa-download text-[11px]" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[12px]" />
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search by question or student name…"
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <select
          value={lectureFilter}
          onChange={e => handleLecture(e.target.value)}
          className="px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-700 outline-none focus:border-indigo-400 transition-all min-w-[180px]"
        >
          <option value="ALL">All lectures</option>
          {lectures.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="space-y-2 w-32 shrink-0">
                <div className="h-3.5 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 bg-slate-100 rounded animate-pulse" />
              </div>
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-40 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 bg-slate-100 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-comments text-2xl text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-600">
            {search || lectureFilter !== 'ALL' ? 'No matching questions' : 'No questions yet'}
          </p>
          <p className="text-sm mt-1">
            {search || lectureFilter !== 'ALL' ? 'Try adjusting your filters.' : 'Questions asked by students via the AI tutor will appear here.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-10">#</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-40">Student</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-44">Lecture</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Question</th>
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-32">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.map((q, i) => (
                <tr key={q.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-4 text-[12px] text-slate-400 tabular-nums">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-[11px] font-bold shrink-0">
                        {q.studentName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-slate-800 truncate">{q.studentName}</p>
                        <p className="text-[10px] text-slate-400 truncate">{q.studentEmail}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="inline-block max-w-[160px] text-[12px] text-slate-600 bg-slate-100 px-2.5 py-1 rounded-lg font-medium truncate">
                      {q.lectureTitle}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-[13px] text-slate-700 line-clamp-2 leading-relaxed max-w-md">{q.question}</p>
                  </td>
                  <td className="px-6 py-4 text-[11px] text-slate-400 whitespace-nowrap">
                    {new Date(q.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex flex-col items-center gap-2">
            <span className="text-[12px] text-slate-400">{filtered.length} question{filtered.length !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[11px]">
                  <i className="fas fa-chevron-left" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-7 h-7 rounded-lg text-[12px] font-semibold border transition-colors ${p === page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[11px]">
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
