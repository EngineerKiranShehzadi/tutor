'use client';
import { useQuery } from '@apollo/client';
import { GET_REGISTERED_STUDENTS } from '@/graphql/analytics.queries';

interface Student { id: string; name: string; email: string; createdAt: string }

const COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-indigo-100 text-indigo-700',
];

export default function AdminStudents() {
  const { data, loading } = useQuery(GET_REGISTERED_STUDENTS, { fetchPolicy: 'network-only' });
  const students: Student[] = data?.registeredStudents ?? [];

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900">Students</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading ? 'Loading…' : `${students.length} registered student${students.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
          <i className="fas fa-user-graduate text-blue-600 text-[15px]" />
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="w-8 h-8 rounded-full bg-slate-100 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-32 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
              </div>
              <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : students.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-users text-2xl text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-600">No students yet</p>
          <p className="text-sm mt-1">Students will appear here once they register.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-10">#</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Student</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Email</th>
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-36">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {students.map((student, i) => {
                const color = COLORS[i % COLORS.length];
                return (
                  <tr key={student.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-6 py-4 text-[12px] text-slate-400 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 ${color}`}>
                          {student.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[14px] font-semibold text-slate-800">{student.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-[13px] text-slate-500">{student.email}</td>
                    <td className="px-6 py-4 text-[12px] text-slate-400">
                      {new Date(student.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
            <span className="text-[12px] text-slate-400">{students.length} student{students.length !== 1 ? 's' : ''} total</span>
          </div>
        </div>
      )}
    </div>
  );
}
