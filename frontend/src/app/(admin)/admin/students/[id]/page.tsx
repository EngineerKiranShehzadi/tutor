'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@apollo/client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { GET_STUDENT_JOURNEY } from '@/graphql/analytics.queries';

interface JourneyQuestion { id: number; question: string; lectureTitle: string; lectureId: number; createdAt: string }
interface LectureEngagement { lectureId: number; lectureTitle: string; questionCount: number; firstAsked: string; lastAsked: string }
interface StudentJourney {
  studentId: string; studentName: string; studentEmail: string;
  status: string; questionCount: number; lecturesEngaged: number;
  joinedAt: string; firstActivity: string | null; lastActivity: string | null;
  questions: JourneyQuestion[];
  byLecture: LectureEngagement[];
}

const AVATAR_COLORS = ['bg-blue-100 text-blue-700','bg-violet-100 text-violet-700','bg-emerald-100 text-emerald-700','bg-amber-100 text-amber-700','bg-rose-100 text-rose-700','bg-indigo-100 text-indigo-700'];
const BAR_COLORS = ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444'];

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-100 ${className}`} />;
}

export default function StudentJourneyPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const { data, loading, error } = useQuery(GET_STUDENT_JOURNEY, {
    variables: { id },
    fetchPolicy: 'network-only',
  });

  const journey: StudentJourney | undefined = data?.studentJourney;
  const avatarColor = AVATAR_COLORS[0];

  if (error) return (
    <div className="max-w-4xl">
      <button onClick={() => router.back()} className="flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-800 transition-colors mb-6">
        <i className="fas fa-arrow-left text-[11px]" /> Back to Students
      </button>
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-14 flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
          <i className="fas fa-user-graduate text-2xl text-slate-400" />
        </div>
        <p className="text-[17px] font-semibold text-slate-700">No Activity Yet</p>
        <p className="text-[14px] text-slate-400 mt-1.5 max-w-xs">This student hasn&apos;t interacted with the AI tutor yet. Activity will appear here once they start asking questions.</p>
        <button
          onClick={() => router.back()}
          className="mt-6 flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-[14px] font-semibold hover:bg-indigo-700 transition-colors"
        >
          <i className="fas fa-arrow-left text-[12px]" /> Back to Students
        </button>
      </div>
    </div>
  );

  return (
    <div className="max-w-[1500px]">
      {/* Back */}
      <button onClick={() => router.back()}
        className="flex items-center gap-1.5 text-[14px] text-slate-500 hover:text-slate-800 transition-colors mb-6">
        <i className="fas fa-arrow-left text-[11px]" /> Back to Students
      </button>

      {/* Header */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-5 flex items-center gap-4">
          <Skeleton className="w-14 h-14 rounded-full" />
          <div className="space-y-2 flex-1"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-56" /></div>
        </div>
      ) : journey && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-5">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center text-[22px] font-bold shrink-0 ${avatarColor}`}>
              {journey.studentName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-[24px] font-bold text-slate-900">{journey.studentName}</h1>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold border ${
                  journey.status === 'ACTIVE'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${journey.status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-slate-400'}`} />
                  {journey.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                </span>
              </div>
              <p className="text-[14px] text-slate-500 mt-0.5">{journey.studentEmail}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[12px] text-slate-400 font-medium">Joined</p>
              <p className="text-[14px] font-semibold text-slate-700">
                {new Date(journey.joinedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats row */}
      {loading ? (
        <div className="grid grid-cols-4 gap-4 mb-5">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : journey && (
        <div className="grid grid-cols-4 gap-4 mb-5">
          {[
            { label: 'Questions Asked',   value: journey.questionCount,   icon: 'fas fa-comments',    bg: 'bg-indigo-600' },
            { label: 'Lectures Engaged',  value: journey.lecturesEngaged, icon: 'fas fa-play-circle', bg: 'bg-violet-600' },
            { label: 'First Activity',    value: journey.firstActivity ? new Date(journey.firstActivity).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—', icon: 'fas fa-calendar-plus', bg: 'bg-emerald-600' },
            { label: 'Last Activity',     value: journey.lastActivity  ? new Date(journey.lastActivity).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—', icon: 'fas fa-calendar-check', bg: 'bg-amber-500'  },
          ].map(c => (
            <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
                <i className={`${c.icon} text-white text-[14px]`} />
              </div>
              <div>
                <p className="text-[26px] font-extrabold text-slate-900 leading-none">{c.value}</p>
                <p className="text-[13px] text-slate-500 mt-0.5 font-medium">{c.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {journey && journey.questionCount === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-comment-slash text-3xl mb-3" />
          <p className="text-base font-semibold text-slate-600">No activity yet</p>
          <p className="text-sm mt-1">This student hasn't asked any questions through the AI tutor.</p>
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-5">

          {/* Questions by lecture — bar chart */}
          <div className="col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h2 className="text-[16px] font-bold text-slate-800 mb-0.5">Engagement per Lecture</h2>
            <p className="text-[12px] text-slate-400 mb-4">Questions asked per lecture</p>
            {loading ? (
              <Skeleton className="h-48 w-full" />
            ) : journey && (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={journey.byLecture.map(l => ({
                    name: l.lectureTitle.length > 14 ? l.lectureTitle.slice(0, 12) + '…' : l.lectureTitle,
                    fullName: l.lectureTitle,
                    Questions: l.questionCount,
                  }))}
                  margin={{ top: 4, right: 8, left: -18, bottom: 0 }}
                  barSize={28}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                    formatter={(v, _, p) => [v, (p as { payload: { fullName: string } }).payload.fullName]}
                    labelFormatter={() => ''}
                  />
                  <Bar dataKey="Questions" radius={[6, 6, 0, 0]}>
                    {(journey?.byLecture ?? []).map((_: LectureEngagement, i: number) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Questions list */}
          <div className="col-span-3 bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col">
            <h2 className="text-[16px] font-bold text-slate-800 mb-0.5">All Questions</h2>
            <p className="text-[12px] text-slate-400 mb-4">Chronological interaction history</p>
            {loading ? (
              <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
            ) : journey && (
              <div className="flex flex-col gap-2.5 overflow-y-auto" style={{ maxHeight: 360 }}>
                {journey.questions.map((q, i) => (
                  <div key={q.id} className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 hover:border-slate-200 transition-colors">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-bold text-slate-400 tabular-nums">#{i + 1}</span>
                      <span className="text-[12px] bg-indigo-50 text-indigo-600 border border-indigo-100 px-2 py-0.5 rounded-md font-medium truncate max-w-[200px]">
                        {q.lectureTitle}
                      </span>
                      <span className="ml-auto text-[12px] text-slate-400 shrink-0">
                        {new Date(q.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-[14px] text-slate-700 leading-relaxed line-clamp-2">{q.question}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
