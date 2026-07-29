'use client';
import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client';
import { GET_ALL_USERS } from '@/graphql/admin.queries';
import { DELETE_USER_MUTATION, UPDATE_USER_ROLE_MUTATION } from '@/graphql/admin.mutations';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

interface User { id: string; name: string; email: string; role: string; isVerified: boolean; createdAt: string }

const PAGE_SIZE = 10;

function exportCSV(users: User[]) {
  const rows = [['Name', 'Email', 'Verified', 'Joined']];
  users.forEach(u => rows.push([u.name, u.email, u.isVerified ? 'Yes' : 'No', new Date(u.createdAt).toLocaleDateString()]));
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'users.csv';
  a.click();
}

export default function AdminUsersPage() {
  const { data, loading, refetch } = useQuery(GET_ALL_USERS, { fetchPolicy: 'network-only' });
  const [deleteUser]     = useMutation(DELETE_USER_MUTATION);
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION);

  const [search,  setSearch]  = useState('');
  const [page, setPage]       = useState(1);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const allUsers: User[] = (data?.allUsers ?? []).filter((u: User) => u.role === 'STUDENT');

  const filtered = allUsers.filter(u =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged      = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleDelete = async (u: User) => {
    if (!confirm(`Delete "${u.name}" (${u.email})? This cannot be undone.`)) return;
    try {
      await deleteUser({ variables: { id: u.id } });
      refetch();
    } catch (err: unknown) {
      alert((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Delete failed');
    }
  };

  const handleRoleToggle = async (u: User) => {
    const newRole = u.role === 'ADMIN' ? 'STUDENT' : 'ADMIN';
    if (!confirm(`Change "${u.name}" from ${u.role} → ${newRole}?`)) return;
    setUpdatingId(u.id);
    try {
      await updateUserRole({ variables: { id: u.id, role: newRole } });
      refetch();
    } catch (err: unknown) {
      alert((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Role update failed');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-users-gear"
        iconGradient="from-cyan-500 to-blue-600"
        title="User Management"
        subtitle={loading ? 'Loading…' : `${allUsers.length} student${allUsers.length !== 1 ? 's' : ''} registered`}
        action={
          <button
            onClick={() => exportCSV(filtered)}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[14px] font-semibold hover:bg-white/25 transition-all"
          >
            <i className="fas fa-download text-[12px]" /> Export CSV
          </button>
        }
      />

      {/* Search */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[13px]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or email…"
            className="w-full pl-9 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="w-9 h-9 rounded-full bg-slate-100 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2"><div className="h-4 w-32 bg-slate-100 rounded animate-pulse" /><div className="h-3.5 w-48 bg-slate-100 rounded animate-pulse" /></div>
              <div className="w-16 h-6 bg-slate-100 rounded-full animate-pulse" />
              <div className="w-20 h-8 bg-slate-100 rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-users text-3xl mb-3" />
          <p className="text-[17px] font-semibold text-slate-600">No users found</p>
          <p className="text-[14px] mt-1">Try adjusting your search.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">#</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">User</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Status</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-32">Joined</th>
                <th className="text-right px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-36">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.map((u, i) => (
                <tr key={u.id} className="hover:bg-slate-50/60 transition-colors group">
                  <td className="px-6 py-4 text-[13px] text-slate-400 tabular-nums">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-[13px] font-bold shrink-0">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-slate-800 truncate">{u.name}</p>
                        <p className="text-[13px] text-slate-400 truncate">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    {u.isVerified ? (
                      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                        <i className="fas fa-circle-check text-[10px]" /> Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
                        <i className="fas fa-clock text-[10px]" /> Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-[13px] text-slate-400">
                    {new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleRoleToggle(u)}
                        disabled={updatingId === u.id}
                        title="Promote to Admin"
                        className="px-3 py-1.5 rounded-lg bg-violet-50 text-violet-700 text-[12px] font-semibold hover:bg-violet-100 transition-colors border border-violet-100 disabled:opacity-40"
                      >
                        {updatingId === u.id
                          ? <i className="fas fa-spinner fa-spin text-[11px]" />
                          : <><i className="fas fa-user-shield text-[11px] mr-1" />Promote</>
                        }
                      </button>
                      <button
                        onClick={() => handleDelete(u)}
                        className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-[12px] font-semibold hover:bg-red-100 transition-colors border border-red-100"
                      >
                        <i className="fas fa-trash text-[11px]" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="text-[13px] text-slate-400">{filtered.length} user{filtered.length !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[12px]">
                  <i className="fas fa-chevron-left" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
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
