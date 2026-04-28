'use client';
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

export default function AdminQuestions() {
  const { data, loading } = useQuery(GET_RECENT_QUESTIONS, { fetchPolicy: 'network-only' });
  const questions: RecentQuestion[] = data?.recentQuestions ?? [];

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
        <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
          <i className="fas fa-comments text-emerald-600 text-[15px]" />
        </div>
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
      ) : questions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-comments text-2xl text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-600">No questions yet</p>
          <p className="text-sm mt-1">Questions asked by students via the AI tutor will appear here.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-40">Student</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-44">Lecture</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Question</th>
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-32">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {questions.map((q) => (
                <tr key={q.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-4">
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
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
            <span className="text-[12px] text-slate-400">{questions.length} question{questions.length !== 1 ? 's' : ''} total</span>
          </div>
        </div>
      )}
    </div>
  );
}
