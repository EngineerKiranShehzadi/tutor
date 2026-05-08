'use client';
import { useQuery } from '@apollo/client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  GET_ANALYTICS_SUMMARY,
  GET_QUESTIONS_PER_LECTURE,
  GET_RECENT_QUESTIONS,
  GET_REGISTERED_STUDENTS,
} from '@/graphql/analytics.queries';

const STAT_CARDS = [
  {
    key: 'totalStudents',
    label: 'Total Students',
    icon: 'fas fa-chalkboard-user',
    bg: 'bg-blue-600',
    light: 'bg-blue-50 text-blue-700',
  },
  {
    key: 'totalLectures',
    label: 'Total Lectures',
    icon: 'fas fa-video',
    bg: 'bg-violet-600',
    light: 'bg-violet-50 text-violet-700',
  },
  {
    key: 'totalQuestions',
    label: 'Questions Asked',
    icon: 'fas fa-circle-question',
    bg: 'bg-emerald-600',
    light: 'bg-emerald-50 text-emerald-700',
  },
  {
    key: 'readyAgents',
    label: 'Active AI Agents',
    icon: 'fas fa-brain',
    bg: 'bg-indigo-600',
    light: 'bg-indigo-50 text-indigo-700',
  },
];

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-100 ${className}`} />;
}

export default function AdminDashboard() {
  const { data: summaryData, loading: summaryLoading } = useQuery(GET_ANALYTICS_SUMMARY, { fetchPolicy: 'network-only' });
  const { data: perLecture, loading: perLectureLoading } = useQuery(GET_QUESTIONS_PER_LECTURE, { fetchPolicy: 'network-only' });
  const { data: recentData, loading: recentLoading } = useQuery(GET_RECENT_QUESTIONS, { fetchPolicy: 'network-only' });

  const { data: studentsData } = useQuery(GET_REGISTERED_STUDENTS, { fetchPolicy: 'network-only' });

  const summary     = summaryData?.analyticsSummary;
  const qPerLecture = perLecture?.questionsPerLecture ?? [];
  const recent      = recentData?.recentQuestions ?? [];
  const students    = studentsData?.registeredStudents ?? [];
  const activeCount   = students.filter((s: { status: string }) => s.status === 'ACTIVE').length;
  const inactiveCount = students.filter((s: { status: string }) => s.status === 'INACTIVE').length;
  const activePct = students.length > 0 ? Math.round((activeCount / students.length) * 100) : 0;

  return (
    <div className="max-w-6xl">
      {/* Page header */}
      <div className="mb-7">
        <h1 className="text-[22px] font-bold text-slate-900">Overview</h1>
        <p className="text-sm text-slate-500 mt-0.5">Monitor platform activity and AI agent performance.</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4 mb-7">
        {STAT_CARDS.map(({ key, label, icon, bg, light }) => (
          <div key={key} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center shadow-sm`}>
                <i className={`${icon} text-white text-[14px]`} />
              </div>
              <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${light}`}>Live</span>
            </div>
            {summaryLoading ? (
              <Skeleton className="h-8 w-14 mb-1" />
            ) : (
              <p className="text-3xl font-extrabold text-slate-900 leading-none">
                {summary?.[key as keyof typeof summary] ?? 0}
              </p>
            )}
            <p className="text-[12px] text-slate-500 mt-1.5 font-medium">{label}</p>
          </div>
        ))}
      </div>

      {/* Student engagement strip */}
      {students.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-5 flex items-center gap-6">
          <div className="shrink-0">
            <p className="text-[13px] font-bold text-slate-700 mb-0.5">Student Engagement</p>
            <p className="text-[11px] text-slate-400">Based on AI tutor interactions</p>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1.5 text-[11px] font-semibold">
              <span className="text-emerald-600">{activeCount} Active ({activePct}%)</span>
              <span className="text-slate-400">{inactiveCount} Inactive ({100 - activePct}%)</span>
            </div>
            <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden flex">
              <div className="h-full bg-emerald-500 rounded-l-full transition-all duration-700" style={{ width: `${activePct}%` }} />
              <div className="h-full bg-slate-200 rounded-r-full flex-1" />
            </div>
          </div>
          <div className="flex items-center gap-5 shrink-0">
            <div className="text-center">
              <p className="text-[22px] font-extrabold text-emerald-600 leading-none">{activeCount}</p>
              <p className="text-[10px] text-slate-400 mt-0.5 font-medium">Active</p>
            </div>
            <div className="w-px h-8 bg-slate-200" />
            <div className="text-center">
              <p className="text-[22px] font-extrabold text-slate-400 leading-none">{inactiveCount}</p>
              <p className="text-[10px] text-slate-400 mt-0.5 font-medium">Inactive</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-5 gap-5">
        {/* Questions per lecture — 3 cols */}
        <div className="col-span-3 bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-[15px] font-bold text-slate-900">Engagement by Lecture</h2>
              <p className="text-[12px] text-slate-400 mt-0.5">Questions asked per AI agent</p>
            </div>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
              <i className="fas fa-chart-bar text-indigo-500 text-[12px]" />
            </div>
          </div>

          {perLectureLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : qPerLecture.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-slate-400">
              <i className="fas fa-chart-bar text-3xl mb-2" />
              <p className="text-sm font-medium">No data yet</p>
              <p className="text-[12px] mt-0.5">Questions will appear here once students start asking.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={qPerLecture.map((item: { lectureId: number; lectureTitle: string; count: number }) => ({
                  name: item.lectureTitle.length > 18 ? item.lectureTitle.slice(0, 16) + '…' : item.lectureTitle,
                  fullName: item.lectureTitle,
                  Questions: item.count,
                }))}
                margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
                barSize={32}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: '#94a3b8', fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: '#f1f5f9', radius: 6 }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12, color: '#334155' }}
                  formatter={(value: number, _: string, props: { payload: { fullName: string } }) => [value, props.payload.fullName]}
                  labelFormatter={() => ''}
                />
                <Bar dataKey="Questions" radius={[6, 6, 0, 0]}>
                  {qPerLecture.map((_: unknown, index: number) => (
                    <Cell
                      key={index}
                      fill={index % 2 === 0 ? '#6366f1' : '#818cf8'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Recent questions — 2 cols */}
        <div className="col-span-2 bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-[15px] font-bold text-slate-900">Recent Questions</h2>
              <p className="text-[12px] text-slate-400 mt-0.5">Latest student interactions</p>
            </div>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
              <i className="fas fa-bolt text-emerald-500 text-[12px]" />
            </div>
          </div>

          {recentLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 text-slate-400 py-6">
              <i className="fas fa-comments text-3xl mb-2" />
              <p className="text-sm font-medium">No activity yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
              {recent.slice(0, 10).map((q: {
                id: number; studentName: string; lectureTitle: string; question: string; createdAt: string;
              }) => (
                <div key={q.id} className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 hover:border-slate-200 transition-colors">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="w-4 h-4 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-[8px] font-bold shrink-0">
                      {q.studentName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-[11px] font-semibold text-slate-700">{q.studentName}</span>
                    <span className="text-[10px] text-slate-300">·</span>
                    <span className="text-[10px] text-slate-400 truncate">{q.lectureTitle}</span>
                  </div>
                  <p className="text-[12px] text-slate-600 line-clamp-2 leading-relaxed">{q.question}</p>
                  <p className="text-[10px] text-slate-400 mt-1.5">
                    {new Date(q.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
