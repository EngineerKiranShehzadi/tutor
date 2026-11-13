'use client';
import { useEffect, useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import { useApolloClient, useQuery, useMutation } from '@apollo/client';
import { GET_ALL_USERS } from '@/graphql/admin.queries';
import { DELETE_USER_MUTATION, UPDATE_USER_ROLE_MUTATION } from '@/graphql/admin.mutations';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { useAuth } from '@/hooks/useAuth';

interface User { id: string; name: string; email: string; role: string; isVerified: boolean; createdAt: string }

const PAGE_SIZE = 10;
// Export pages through the same server API, 100 rows at a time (AD6).
const EXPORT_PAGE = 100;
const EXPORT_MAX = 20_000;

interface UserPage {
  items: User[]; total: number; hasMore: boolean;
  totalUsers: number; studentCount: number; adminCount: number;
}

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
  downloadCsv('users.csv', rows);
}

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const client = useApolloClient();
  const [deleteUser]     = useMutation(DELETE_USER_MUTATION);
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION);

  const [searchInput, setSearchInput] = useState('');
  const [search,      setSearch]      = useState('');
  const [roleFilter,  setRoleFilter]  = useState<RoleFilter>('ALL');
  const [page,        setPage]        = useState(1);
  const [updatingId,  setUpdatingId]  = useState<string | null>(null);
  const [exporting,   setExporting]   = useState(false);

  // Search and the role filter run on the server; wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Both roles. Admins used to be filtered out of this screen, which made them
  // impossible to see, demote or delete — a one-way door: you could promote
  // someone and then never undo it.
  const filters = { search: search || null, role: roleFilter === 'ALL' ? null : roleFilter };
  const { data, loading, refetch } = useQuery<{ allUsers: UserPage }>(GET_ALL_USERS, {
    variables: { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...filters },
    fetchPolicy: 'network-only',
  });
  const result       = data?.allUsers;
  const paged        = result?.items ?? [];
  const total        = result?.total ?? 0;
  const totalUsers   = result?.totalUsers ?? 0;
  const studentCount = result?.studentCount ?? 0;
  const adminCount   = result?.adminCount ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamped rather than trusted: deleting the only row on the last page, or
  // narrowing the filter, can leave `page` pointing past the end of the list.
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (result && page > totalPages) setPage(totalPages); }, [result, page, totalPages]);

  // Every user matching the current filters, fetched page by page.
  const handleExport = async () => {
    setExporting(true);
    try {
      const all: User[] = [];
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const { data: d } = await client.query<{ allUsers: UserPage }>({
          query: GET_ALL_USERS,
          variables: { limit: EXPORT_PAGE, offset, ...filters },
          fetchPolicy: 'network-only',
        });
        all.push(...d.allUsers.items);
        if (!d.allUsers.hasMore) break;
      }
      exportCSV(all);
    } catch {
      alert('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

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
    { key: 'ALL',     label: 'All',      count: totalUsers },
    { key: 'STUDENT', label: 'Students', count: studentCount },
    { key: 'ADMIN',   label: 'Admins',   count: adminCount },
  ];

  const subtitle = loading && !data
    ? 'Loading…'
    : `${totalUsers} user${totalUsers !== 1 ? 's' : ''} · ${studentCount} student${studentCount !== 1 ? 's' : ''} · ${adminCount} admin${adminCount !== 1 ? 's' : ''}`;

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        icon="fas fa-users-gear"
        iconGradient=" "
        title="User Management"
        subtitle={subtitle}
        action={
          <button
            onClick={() => { void handleExport(); }}
            disabled={loading || exporting || total === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 rounded-card text-label font-semibold hover:bg-white/25 transition-colors disabled:opacity-40"
          >
            <i className={`fas ${exporting ? 'fa-spinner fa-spin' : 'fa-download'} text-caption`} /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      {/* Search + role filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-caption" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full pl-9 pr-4 py-3 bg-[var(--card)] border border-[var(--border)] rounded-card text-label text-[var(--text)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>
        <div className="flex items-center gap-1.5 bg-[var(--card)] border border-[var(--border)] rounded-card p-1.5 shrink-0">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => { setRoleFilter(t.key); setPage(1); }}
              className={`px-3.5 py-2 rounded-card text-caption font-semibold transition-colors ${
                roleFilter === t.key
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:bg-[var(--surface)]'
              }`}
            >
              {t.label}
              <span className={`ml-1.5 tabular-nums ${roleFilter === t.key ? 'text-white/70' : 'text-[var(--muted2)]'}`}>
                {t.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-[var(--border)] last:border-0">
              <div className="w-9 h-9 rounded-full bg-[var(--surface)] animate-pulse shrink-0" />
              <div className="flex-1 space-y-2"><div className="h-4 w-32 bg-[var(--surface)] rounded animate-pulse" /><div className="h-3.5 w-48 bg-[var(--surface)] rounded animate-pulse" /></div>
              <div className="w-16 h-6 bg-[var(--surface)] rounded-full animate-pulse" />
              <div className="w-20 h-8 bg-[var(--surface)] rounded-card animate-pulse" />
            </div>
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] flex flex-col items-center justify-center py-20 text-[var(--muted2)]">
          <i className="fas fa-users text-display mb-3" />
          <p className="text-h3 font-semibold text-[var(--muted)]">No users found</p>
          <p className="text-label mt-1">
            {search ? 'Try adjusting your search.' : 'There are no users with this role yet.'}
          </p>
        </div>
      ) : (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface)]">
                <th className="text-left px-6 py-4 text-caption font-semibold text-[var(--muted)]">#</th>
                <th className="text-left px-4 py-4 text-caption font-semibold text-[var(--muted)]">User</th>
                <th className="text-left px-4 py-4 text-caption font-semibold text-[var(--muted)] w-32">Role</th>
                <th className="text-left px-4 py-4 text-caption font-semibold text-[var(--muted)]">Status</th>
                <th className="text-left px-4 py-4 text-caption font-semibold text-[var(--muted)] w-32">Joined</th>
                <th className="text-right px-6 py-4 text-caption font-semibold text-[var(--muted)] w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {paged.map((u, i) => {
                const self  = isSelf(u);
                const admin = u.role === 'ADMIN';
                return (
                  <tr key={u.id} className={`transition-colors group ${self ? 'bg-[var(--surface)]' : 'hover:bg-[var(--surface)]'}`}>
                    <td className="px-6 py-4 text-caption text-[var(--muted2)] tabular-nums">{(safePage - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-caption font-semibold shrink-0 ${
                          admin ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--surface)] text-[var(--muted)]'
                        }`}>
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-label font-semibold text-[var(--text)] truncate flex items-center gap-2">
                            {u.name}
                            {self && (
                              <span className="text-[11px] font-medium text-[var(--muted)]">(you)</span>
                            )}
                          </p>
                          <p className="text-caption text-[var(--muted2)] truncate">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {admin ? (
                        <span className="inline-flex items-center gap-1 text-caption font-semibold text-[var(--accent)] bg-[var(--accent-soft)] border border-[var(--border)] px-2.5 py-1 rounded-full">
                          <i className="fas fa-user-shield text-[10px]" /> Admin
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-caption font-semibold text-[var(--muted)] bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1 rounded-full">
                          <i className="fas fa-user text-[10px]" /> Student
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {u.isVerified ? (
                        <span className="inline-flex items-center gap-1 text-caption font-semibold text-[var(--accent)] bg-[var(--accent-soft)] border border-[var(--border)] px-2.5 py-1 rounded-full">
                          <i className="fas fa-circle-check text-[10px]" /> Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-caption font-semibold text-[var(--gold)] bg-[var(--gold-soft)] border border-[var(--border)] px-2.5 py-1 rounded-full">
                          <i className="fas fa-clock text-[10px]" /> Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-caption text-[var(--muted2)]">
                      {new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      {self ? (
                        /* You cannot change or remove your own account. The server
                           refuses it as well; saying so here is clearer than
                           offering a button that always errors. */
                        <div className="flex items-center justify-end">
                          <span className="text-caption text-[var(--muted2)] italic">Your account</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5 opacity-70 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleRoleToggle(u)}
                            disabled={updatingId === u.id}
                            title={admin ? 'Change to Student' : 'Change to Admin'}
                            className={`px-3 py-1.5 rounded-card text-caption font-semibold transition-colors border disabled:opacity-40 ${
                              admin
                                ? 'bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface)] border-[var(--border)]'
                                : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-soft)] border-[var(--border)]'
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
                            className="px-3 py-1.5 rounded-card bg-[var(--gold-soft)] text-[var(--gold)] text-caption font-semibold hover:bg-[var(--gold-soft)] transition-colors border border-[var(--border)]"
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
          <div className="px-6 py-3.5 border-t border-[var(--border)] bg-[var(--surface)] flex items-center justify-between">
            <span className="text-caption text-[var(--muted2)]">{total} user{total !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                  className="w-8 h-8 rounded-card border border-[var(--border)] flex items-center justify-center text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-30 text-caption">
                  <i className="fas fa-chevron-left" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded-card text-caption font-semibold border transition-colors ${p === safePage ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface)]'}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                  className="w-8 h-8 rounded-card border border-[var(--border)] flex items-center justify-center text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-30 text-caption">
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
