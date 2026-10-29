'use client';
import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client';
import { GET_ALL_USERS } from '@/graphql/admin.queries';
import { DELETE_USER_MUTATION, UPDATE_USER_ROLE_MUTATION } from '@/graphql/admin.mutations';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { useAuth } from '@/hooks/useAuth';

interface User { id: string; name: string; email: string; role: string; isVerified: boolean; createdAt: string }

const PAGE_SIZE = 10;

type RoleFilter = 'ALL' | 'STUDENT' | 'ADMIN';

function exportCSV(users: User[]) {
  const rows = [['Name', 'Email', 'Role', 'Verified', 'Joined']];
  users.forEach(u => rows.push([
    u.name,
    u.email,
    u.role,
    u.isVerified ? 'Yes' : 'No',
    new Date(u.createdAt).toLocaleDateString(),
  ]));
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'users.csv';
  a.click();
}

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const { data, loading, refetch } = useQuery(GET_ALL_USERS, { fetchPolicy: 'network-only' });
  const [deleteUser]     = useMutation(DELETE_USER_MUTATION);
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION);

  const [search,     setSearch]     = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [page,       setPage]       = useState(1);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Every user, both roles. Admins used to be filtered out right here, which
  // made them impossible to see, demote or delete from this screen — a
  // one-way door: you could promote someone and then never undo it.
  const allUsers: User[] = data?.allUsers ?? [];

  const studentCount = allUsers.filter(u => u.role === 'STUDENT').length;
  const adminCount   = allUsers.filter(u => u.role === 'ADMIN').length;

  const filtered = allUsers.filter(u => {
    if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than trusted: deleting the only row on the last page, or
  // narrowing the filter, can leave `page` pointing past the end of the list.
  const safePage = Math.min(page, totalPages);
  const paged    = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const isSelf = (u: User) => !!currentUser && u.id === currentUser.id;

  const handleDelete = async (u: User) => {
    // The server refuses this too; the check is here so the button is never
    // offered in a state that can only fail.
    if (isSelf(u)) return;
    const what = u.role === 'ADMIN' ? 'admin' : 'student';
    if (!confirm(`Delete the ${what} "${u.name}" (${u.email})?\n\nTheir questions and chat history are deleted with them. This cannot be undone.`)) return;
    try {
      await deleteUser({ variables: { id: u.id } });
      refetch();
    } catch (err: unknown) {
      alert((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Delete failed');
    }
  };

  const handleRoleToggle = async (u: User) => {
    if (isSelf(u)) return;
    const promoting = u.role !== 'ADMIN';
    const newRole   = promoting ? 'ADMIN' : 'STUDENT';
    const warning   = promoting
      ? '\n\nAdmins can see every student’s questions, upload datasets and delete accounts.'
      : '';
    if (!confirm(`Change "${u.name}" from ${u.role} to ${newRole}?${warning}`)) return;
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

  const tabs: { key: RoleFilter; label: string; count: number }[] = [
    { key: 'ALL',     label: 'All',      count: allUsers.length },
    { key: 'STUDENT', label: 'Students', count: studentCount },
    { key: 'ADMIN',   label: 'Admins',   count: adminCount },
  ];

  const subtitle = loading
    ? 'Loading…'
    : `${allUsers.length} user${allUsers.length !== 1 ? 's' : ''} · ${studentCount} student${studentCount !== 1 ? 's' : ''} · ${adminCount} admin${adminCount !== 1 ? 's' : ''}`;

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-users-gear"
        iconGradient="from-cyan-500 to-blue-600"
        title="User Management"
        subtitle={subtitle}
        action={
          <button
            onClick={() => exportCSV(filtered)}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[14px] font-semibold hover:bg-white/25 transition-all"
          >
            <i className="fas fa-download text-[12px]" /> Export CSV
          </button>
        }
      />

      {/* Search + role filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[13px]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or email…"
            className="w-full pl-9 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl p-1.5 shrink-0">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => { setRoleFilter(t.key); setPage(1); }}
              className={`px-3.5 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
                roleFilter === t.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t.label}
              <span className={`ml-1.5 tabular-nums ${roleFilter === t.key ? 'text-white/70' : 'text-slate-400'}`}>
                {t.count}
              </span>
            </button>
          ))}
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
          <p className="text-[14px] mt-1">
            {search ? 'Try adjusting your search.' : 'There are no users with this role yet.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">#</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">User</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-32">Role</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest">Status</th>
                <th className="text-left px-4 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-32">Joined</th>
                <th className="text-right px-6 py-4 text-[12px] font-semibold text-slate-500 uppercase tracking-widest w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.map((u, i) => {
                const self  = isSelf(u);
                const admin = u.role === 'ADMIN';
                return (
                  <tr key={u.id} className={`transition-colors group ${self ? 'bg-indigo-50/40' : 'hover:bg-slate-50/60'}`}>
                    <td className="px-6 py-4 text-[13px] text-slate-400 tabular-nums">{(safePage - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 ${
                          admin ? 'bg-violet-100 text-violet-700' : 'bg-indigo-100 text-indigo-700'
                        }`}>
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[15px] font-semibold text-slate-800 truncate flex items-center gap-2">
                            {u.name}
                            {self && (
                              <span className="text-[11px] font-bold text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded">YOU</span>
                            )}
                          </p>
                          <p className="text-[13px] text-slate-400 truncate">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {admin ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-full">
                          <i className="fas fa-user-shield text-[10px]" /> Admin
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-full">
                          <i className="fas fa-user text-[10px]" /> Student
                        </span>
                      )}
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
                      {self ? (
                        /* You cannot change or remove your own account. The server
                           refuses it as well; saying so here is clearer than
                           offering a button that always errors. */
                        <div className="flex items-center justify-end">
                          <span className="text-[12px] text-slate-400 italic">Your account</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5 opacity-70 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleRoleToggle(u)}
                            disabled={updatingId === u.id}
                            title={admin ? 'Change to Student' : 'Change to Admin'}
                            className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors border disabled:opacity-40 ${
                              admin
                                ? 'bg-slate-50 text-slate-700 hover:bg-slate-100 border-slate-200'
                                : 'bg-violet-50 text-violet-700 hover:bg-violet-100 border-violet-100'
                            }`}
                          >
                            {updatingId === u.id
                              ? <i className="fas fa-spinner fa-spin text-[11px]" />
                              : <><i className={`fas ${admin ? 'fa-user' : 'fa-user-shield'} text-[11px] mr-1`} />{admin ? 'Demote' : 'Promote'}</>
                            }
                          </button>
                          <button
                            onClick={() => handleDelete(u)}
                            title="Delete user"
                            className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-[12px] font-semibold hover:bg-red-100 transition-colors border border-red-100"
                          >
                            <i className="fas fa-trash text-[11px]" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Footer */}
          <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="text-[13px] text-slate-400">{filtered.length} user{filtered.length !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                  className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[12px]">
                  <i className="fas fa-chevron-left" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded-lg text-[13px] font-semibold border transition-colors ${p === safePage ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
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
