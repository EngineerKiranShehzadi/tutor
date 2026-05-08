'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@apollo/client';
import { cn } from '@/lib/cn';
import { GET_REGISTERED_STUDENTS } from '@/graphql/analytics.queries';
import { DELETE_USER_MUTATION } from '@/graphql/admin.mutations';

interface Student {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  questionCount: number;
  status: 'ACTIVE' | 'INACTIVE';
}

const COLORS = ['bg-blue-100 text-blue-700','bg-violet-100 text-violet-700','bg-emerald-100 text-emerald-700','bg-amber-100 text-amber-700','bg-rose-100 text-rose-700','bg-indigo-100 text-indigo-700'];
const PAGE_SIZE = 10;

const STATUS_CONFIG = {
  ACTIVE:   { label: 'Active',   dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  INACTIVE: { label: 'Inactive', dot: 'bg-slate-400',   text: 'text-slate-500',  bg: 'bg-slate-100',  border: 'border-slate-200'   },
};

function exportCSV(students: Student[]) {
  const rows = [['Name','Email','Status','Questions Asked','Joined']];
  students.forEach(s => rows.push([
    s.name, s.email, s.status, String(s.questionCount),
    new Date(s.createdAt).toLocaleDateString(),
  ]));
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'students.csv';
  a.click();
}

export default function AdminStudents() {
  const router = useRouter();
  const { data, loading, refetch } = useQuery(GET_REGISTERED_STUDENTS, { fetchPolicy: 'network-only' });
  const [deleteUser] = useMutation(DELETE_USER_MUTATION);

  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page,         setPage]         = useState(1);
  const [deleteId,     setDeleteId]     = useState<string | null>(null);
  const [deleteError,  setDeleteError]  = useState('');

  const allStudents: Student[] = data?.registeredStudents ?? [];

  const activeCount   = allStudents.filter(s => s.status === 'ACTIVE').length;
  const inactiveCount = allStudents.filter(s => s.status === 'INACTIVE').length;

  const filtered = allStudents.filter(s => {
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.email.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'ALL' || s.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleDelete = async (id: string) => {
    if (deleteId !== id) { setDeleteId(id); setDeleteError(''); return; }
    try {
      await deleteUser({ variables: { id } });
      refetch();
      setDeleteId(null);
    } catch (err: unknown) {
      setDeleteError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Delete failed.');
    }
  };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900">Students</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading ? 'Loading…' : `${allStudents.length} registered student${allStudents.length !== 1 ? 's' : ''}`}
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

      {/* Delete error banner */}
      {deleteError && (
        <div className="mb-4 flex items-center gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
          <i className="fas fa-circle-exclamation shrink-0" /> {deleteError}
          <button onClick={() => setDeleteError('')} className="ml-auto text-red-400 hover:text-red-600"><i className="fas fa-xmark" /></button>
        </div>
      )}

      {/* Status summary cards */}
      {!loading && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Total Students', value: allStudents.length, icon: 'fas fa-users',      bg: 'bg-blue-600',    light: 'bg-blue-50 text-blue-700'       },
            { label: 'Active',         value: activeCount,        icon: 'fas fa-bolt',        bg: 'bg-emerald-600', light: 'bg-emerald-50 text-emerald-700' },
            { label: 'Inactive',       value: inactiveCount,      icon: 'fas fa-user-clock',  bg: 'bg-slate-500',   light: 'bg-slate-100 text-slate-600'    },
          ].map(c => (
            <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
                <i className={`${c.icon} text-white text-[14px]`} />
              </div>
              <div>
                <p className="text-[24px] font-extrabold text-slate-900 leading-none">{c.value}</p>
                <p className="text-[12px] text-slate-500 mt-0.5 font-medium">{c.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Search + Status filter */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[12px]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or email…"
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-700 outline-none focus:border-indigo-400 transition-all"
        >
          <option value="ALL">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="w-8 h-8 rounded-full bg-slate-100 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2"><div className="h-3.5 w-32 bg-slate-100 rounded animate-pulse" /><div className="h-3 w-48 bg-slate-100 rounded animate-pulse" /></div>
              <div className="h-5 w-16 bg-slate-100 rounded-full animate-pulse" />
              <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-users text-2xl text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-600">{search || statusFilter !== 'ALL' ? 'No matching students' : 'No students yet'}</p>
          <p className="text-sm mt-1">{search || statusFilter !== 'ALL' ? 'Try adjusting your filters.' : 'Students will appear here once they register.'}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-10">#</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Student</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-28">Status</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-28">Questions</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-32">Joined</th>
                <th className="text-right px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-20">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.map((student, i) => {
                const color = COLORS[((page - 1) * PAGE_SIZE + i) % COLORS.length];
                const sc = STATUS_CONFIG[student.status];
                return (
                  <tr key={student.id} className={cn('transition-colors', deleteId === student.id ? 'bg-red-50' : 'hover:bg-slate-50/60')}>
                    <td className="px-6 py-4 text-[12px] text-slate-400 tabular-nums">{(page - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 ${color}`}>
                          {student.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-slate-800">{student.name}</p>
                          <p className="text-[11px] text-slate-400 truncate">{student.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${sc.bg} ${sc.border} ${sc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {sc.label}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1.5">
                        <i className="fas fa-comments text-[10px] text-slate-400" />
                        <span className="text-[13px] font-semibold text-slate-700 tabular-nums">{student.questionCount}</span>
                        <span className="text-[11px] text-slate-400">asked</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-[12px] text-slate-400">
                      {new Date(student.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      {/* Visibility: actions always visible, no opacity-0 */}
                      <div className="flex justify-end items-center gap-1.5">
                        {deleteId === student.id ? (
                          <>
                            <span className="text-[12px] text-red-600 font-medium mr-1">Delete?</span>
                            <button
                              onClick={() => handleDelete(student.id)}
                              className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-[12px] font-semibold hover:bg-red-700 transition-colors"
                            >
                              Yes, delete
                            </button>
                            <button
                              onClick={() => setDeleteId(null)}
                              className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[12px] font-semibold hover:bg-slate-200 transition-colors border border-slate-200"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {/* Affordance: icon + label so purpose is immediately clear */}
                            <button
                              onClick={() => router.push(`/admin/students/${student.id}`)}
                              className="px-2.5 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-[12px] font-semibold hover:bg-indigo-100 active:scale-95 transition-all border border-indigo-100 flex items-center gap-1"
                            >
                              <i className="fas fa-route text-[10px]" /> View
                            </button>
                            <button
                              onClick={() => handleDelete(student.id)}
                              className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 text-[12px] font-semibold hover:bg-red-100 active:scale-95 transition-all border border-red-100 flex items-center gap-1"
                            >
                              <i className="fas fa-trash text-[10px]" /> Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="text-[12px] text-slate-400">{filtered.length} student{filtered.length !== 1 ? 's' : ''}</span>
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
