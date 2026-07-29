'use client';
import { useQuery } from '@apollo/client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import {
  GET_ANALYTICS_SUMMARY,
  GET_QUESTIONS_PER_LECTURE,
  GET_RECENT_QUESTIONS,
  GET_REGISTERED_STUDENTS,
} from '@/graphql/analytics.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

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
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-chart-pie"
        iconGradient="from-blue-500 to-indigo-600"
        title="Overview"
        subtitle="Monitor platform activity and AI agent performance."
      />

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        {STAT_CARDS.map(({ key, label, icon, bg, light }) => (
          <div key={key} className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between mb-5">
              <div className={`w-12 h-12 rounded-xl ${bg} flex items-center justify-center shadow-sm`}>
                <i className={`${icon} text-white text-[16px]`} />
              </div>
              <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${light}`}>Live</span>
            </div>
            {summaryLoading ? (
              <Skeleton className="h-10 w-16 mb-1" />
            ) : (
              <p className="text-[42px] font-extrabold text-slate-900 leading-none">
                {summary?.[key as keyof typeof summary] ?? 0}
              </p>
            )}
            <p className="text-[14px] text-slate-500 mt-2 font-medium">{label}</p>
          </div>
        ))}
      </div>

      {/* Student engagement strip */}
      {students.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6 flex items-center gap-8">
          <div className="shrink-0">
            <p className="text-[15px] font-bold text-slate-700 mb-0.5">Student Engagement</p>
            <p className="text-[13px] text-slate-400">Based on AI tutor interactions</p>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2 text-[13px] font-semibold">
              <span className="text-emerald-600">{activeCount} Active ({activePct}%)</span>
              <span className="text-slate-400">{inactiveCount} Inactive ({100 - activePct}%)</span>
            </div>
            <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden flex">
              <div className="h-full bg-emerald-500 rounded-l-full transition-all duration-700" style={{ width: `${activePct}%` }} />
              <div className="h-full bg-slate-200 rounded-r-full flex-1" />
            </div>
          </div>
          <div className="flex items-center gap-6 shrink-0">
            <div className="text-center">
              <p className="text-[28px] font-extrabold text-emerald-600 leading-none">{activeCount}</p>
              <p className="text-[12px] text-slate-400 mt-1 font-medium">Active</p>
            </div>
            <div className="w-px h-10 bg-slate-200" />
            <div className="text-center">
              <p className="text-[28px] font-extrabold text-slate-400 leading-none">{inactiveCount}</p>
              <p className="text-[12px] text-slate-400 mt-1 font-medium">Inactive</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-5 gap-6">
        {/* Questions per lecture — 3 cols */}
        <div className="col-span-3 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Card header */}
          <div className="flex items-center justify-between px-7 pt-6 pb-4">
            <div>
              <h2 className="text-[18px] font-bold text-slate-900">Engagement by Lecture</h2>
              <p className="text-[13px] text-slate-400 mt-0.5">Questions asked per AI agent</p>
            </div>
            <div className="flex items-center gap-2">
              {!perLectureLoading && qPerLecture.length > 0 && (
                <span className="text-[12px] font-semibold px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">
                  {qPerLecture.reduce((s: number, l: { count: number }) => s + l.count, 0)} total questions
                </span>
              )}
              <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center">
                <i className="fas fa-chart-column text-indigo-500 text-[14px]" />
              </div>
            </div>
          </div>

          {perLectureLoading ? (
            <div className="px-7 pb-7 space-y-4">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : qPerLecture.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 px-7">
              <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mb-4">
                <i className="fas fa-chart-bar text-3xl text-slate-300" />
              </div>
              <p className="text-[15px] font-semibold text-slate-500">No data yet</p>
              <p className="text-[13px] mt-1">Questions will appear once students start asking.</p>
            </div>
          ) : (
            <>
              <div className="px-4">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart
                    data={qPerLecture.map((item: { lectureId: number; lectureTitle: string; count: number }) => ({
                      name: item.lectureTitle.length > 16 ? item.lectureTitle.slice(0, 14) + '…' : item.lectureTitle,
                      fullName: item.lectureTitle,
                      Questions: item.count,
                    }))}
                    margin={{ top: 28, right: 16, left: -10, bottom: 8 }}
                    barSize={42}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 13, fill: '#64748b', fontWeight: 600 }}
                      axisLine={false}
                      tickLine={false}
                      dy={6}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 13, fill: '#94a3b8', fontWeight: 500 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: '#f8fafc', radius: 8 }}
                      contentStyle={{
                        borderRadius: 12,
                        border: '1px solid #e2e8f0',
                        fontSize: 13,
                        color: '#334155',
                        padding: '10px 14px',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                      }}
                      formatter={(value, _, props) => [`${value} questions`, (props as { payload: { fullName: string } }).payload.fullName]}
                      labelFormatter={() => ''}
                    />
                    <Bar dataKey="Questions" radius={[8, 8, 0, 0]}>
                      <LabelList
                        dataKey="Questions"
                        position="top"
                        style={{ fontSize: 14, fontWeight: 700, fill: '#4f46e5' }}
                      />
                      {qPerLecture.map((_: unknown, index: number) => {
                        const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
                        return <Cell key={index} fill={COLORS[index % COLORS.length]} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Lecture legend rows */}
              <div className="border-t border-slate-100 divide-y divide-slate-50">
                {qPerLecture.map((item: { lectureId: number; lectureTitle: string; count: number }, index: number) => {
                  const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
                  const maxCount = Math.max(...qPerLecture.map((l: { count: number }) => l.count));
                  return (
                    <div key={item.lectureId} className="flex items-center gap-4 px-7 py-3">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ background: COLORS[index % COLORS.length] }} />
                      <p className="flex-1 text-[13px] font-medium text-slate-700 truncate">{item.lectureTitle}</p>
                      <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden shrink-0">
                        <div className="h-full rounded-full" style={{ width: `${Math.round((item.count / maxCount) * 100)}%`, background: COLORS[index % COLORS.length] }} />
                      </div>
                      <span className="text-[13px] font-bold text-slate-700 w-6 text-right shrink-0">{item.count}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Recent questions — 2 cols */}
        <div className="col-span-2 bg-white rounded-2xl border border-slate-200 p-7 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-[18px] font-bold text-slate-900">Recent Questions</h2>
              <p className="text-[13px] text-slate-400 mt-0.5">Latest student interactions</p>
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
                <div key={q.id} className="p-4 rounded-xl bg-slate-50 border border-slate-100 hover:border-slate-200 transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-5 h-5 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-[10px] font-bold shrink-0">
                      {q.studentName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-[13px] font-semibold text-slate-700">{q.studentName}</span>
                    <span className="text-[11px] text-slate-300">·</span>
                    <span className="text-[12px] text-slate-400 truncate">{q.lectureTitle}</span>
                  </div>
                  <p className="text-[13px] text-slate-600 line-clamp-2 leading-relaxed">{q.question}</p>
                  <p className="text-[11px] text-slate-400 mt-2">
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
