'use client';
import { useEffect, useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import { useApolloClient, useQuery, useMutation } from '@apollo/client';
import { GET_ALL_USERS, GET_ADMIN_INVITATIONS } from '@/graphql/admin.queries';
import { DELETE_USER_MUTATION, UPDATE_USER_ROLE_MUTATION,
         INVITE_ADMIN_MUTATION, REVOKE_ADMIN_INVITATION_MUTATION } from '@/graphql/admin.mutations';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnPrimary, btnSecondary, btnRow, filterOn, filterOff } from '@/components/admin/buttons';
import { AdminNotice } from '@/components/admin/AdminNotice';
import { useAuth } from '@/hooks/useAuth';

interface User { id: string; name: string; email: string; role: string; isVerified: boolean; createdAt: string }

interface Invitation {
  id: number; email: string; invitedByName: string | null;
  createdAt: string; expiresAt: string; status: string;
}

const PAGE_SIZE = 10;
// Export pages through the same server API, 100 rows at a time (AD6).
const EXPORT_PAGE = 100;
const EXPORT_MAX = 20_000;

interface UserPage {
  items: User[]; total: number; hasMore: boolean;
  totalUsers: number; studentCount: number; adminCount: number;
}

type RoleFilter = 'ALL' | 'STUDENT' | 'ADMIN';

// Same definition as the Students page, so the two tables' buttons are the
// same size. They were px-3 py-1.5 here and px-3.5 py-2 there.
const outlineBtn = btnRow;

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

/**
 * Admins.
 *
 * This screen and the Students screen both used to list students and both
 * could delete them, so neither had a job of its own. Students is now the
 * place for students and the questions they asked; this is the place for
 * admin accounts. It still opens on the admins alone, but the filter keeps
 * every role, because promoting someone means finding them among the
 * students first.
 */
export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const client = useApolloClient();
  const [deleteUser]     = useMutation(DELETE_USER_MUTATION);
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION);
  const [inviteAdmin]    = useMutation(INVITE_ADMIN_MUTATION);
  const [revokeInvite]   = useMutation(REVOKE_ADMIN_INVITATION_MUTATION);
  const { data: inviteData, refetch: refetchInvites } =
    useQuery<{ adminInvitations: Invitation[] }>(GET_ADMIN_INVITATIONS, { fetchPolicy: 'network-only' });

  const [searchInput, setSearchInput] = useState('');
  const [search,      setSearch]      = useState('');
  const [roleFilter,  setRoleFilter]  = useState<RoleFilter>('ADMIN');
  // Newest first, which is what you want when you open the page. The other
  // order answers "who was here at the start".
  const [sort,        setSort]        = useState<'JOINED_DESC' | 'JOINED_ASC'>('JOINED_DESC');
  const [page,        setPage]        = useState(1);
  const [updatingId,  setUpdatingId]  = useState<string | null>(null);
  const [exporting,   setExporting]   = useState(false);
  const [pageError,   setPageError]   = useState('');
  // Which row is waiting on a confirmation, and for what.
  const [pending,     setPending]     = useState<{ user: User; kind: 'delete' | 'role' } | null>(null);
  const [deleting,    setDeleting]    = useState(false);
  // Inviting someone who has no account yet.
  const [inviteOpen,  setInviteOpen]  = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [notice,      setNotice]      = useState('');

  // Search and the role filter run on the server; wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // The filter keeps both roles. Admins used to be filtered out of this screen,
  // which made them impossible to see, demote or delete — a one-way door: you
  // could promote someone and then never undo it.
  // The order is part of the query, so it covers every page rather than
  // rearranging the ten rows that happen to be on screen.
  const filters = { search: search || null, role: roleFilter === 'ALL' ? null : roleFilter, sort };
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
    setExporting(true); setPageError('');
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
      setPageError('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const isSelf = (u: User) => !!currentUser && u.id === currentUser.id;
  const msgOf = (err: unknown, fallback: string) =>
    (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? fallback;

  // Both of these used to be a browser confirm() box, with failures reported
  // through alert(). Neither belongs in a product screen.
  const confirmDelete = async (u: User) => {
    setDeleting(true);
    try {
      await deleteUser({ variables: { id: u.id } });
      setPending(null);
      refetch();
    } catch (err: unknown) {
      setPending(null);
      setPageError(msgOf(err, 'Delete failed.'));
    } finally {
      setDeleting(false);
    }
  };

  const confirmRole = async (u: User) => {
    const newRole = u.role === 'ADMIN' ? 'STUDENT' : 'ADMIN';
    setUpdatingId(u.id);
    try {
      await updateUserRole({ variables: { id: u.id, role: newRole } });
      setPending(null);
      refetch();
    } catch (err: unknown) {
      setPending(null);
      setPageError(msgOf(err, 'Role update failed.'));
    } finally {
      setUpdatingId(null);
    }
  };

  const submitInvite = async () => {
    setInviting(true); setPageError(''); setNotice('');
    try {
      const { data: d } = await inviteAdmin({ variables: { email: inviteEmail.trim() } });
      const r = d?.inviteAdmin;
      // Never claim an email was sent when it was not: the role change and the
      // invitation both stand on their own, and a silent failure here is how
      // someone ends up waiting for a message that never left.
      const mailNote = r?.emailed ? '' : ' The email could not be sent, so tell them yourself.';
      setNotice(r?.outcome === 'GRANTED'
        ? `${r.name ?? r.email} already had an account and now has the admin role.${r.emailed ? ' They have been emailed.' : mailNote}`
        : `${r?.email} is invited and becomes an admin when they sign up with that address.${r?.emailed ? ' The invitation has been emailed.' : mailNote}`);
      setInviteOpen(false); setInviteEmail('');
      refetch(); refetchInvites();
    } catch (err: unknown) {
      setPageError(msgOf(err, 'That invitation could not be sent.'));
    } finally {
      setInviting(false);
    }
  };

  const withdrawInvite = async (id: number) => {
    setPageError(''); setNotice('');
    try {
      await revokeInvite({ variables: { id } });
      refetchInvites();
    } catch (err: unknown) {
      setPageError(msgOf(err, 'That invitation could not be withdrawn.'));
    }
  };

  const invitations = inviteData?.adminInvitations ?? [];
  const countLabel = `${total.toLocaleString()} ${
    roleFilter === 'ADMIN'   ? (total === 1 ? 'admin' : 'admins') :
    roleFilter === 'STUDENT' ? (total === 1 ? 'student' : 'students') :
                               (total === 1 ? 'person' : 'people')}`;

  const tabs: { key: RoleFilter; label: string; count: number }[] = [
    { key: 'ADMIN',   label: 'Admins',    count: adminCount   },
    { key: 'STUDENT', label: 'Students',  count: studentCount },
    { key: 'ALL',     label: 'All Users', count: totalUsers   },
  ];

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        title="Team"
        subtitle="Who can manage the course. Invite someone new, or give an existing student the admin role."
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void handleExport(); }}
              disabled={loading || exporting || total === 0}
              className={btnSecondary}
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            <button
              onClick={() => { setInviteOpen(true); setPageError(''); setNotice(''); }}
              className={btnPrimary}
            >
              Invite Admin
            </button>
          </div>
        }
      />

      {pageError && <AdminNotice kind="error" message={pageError} onDismiss={() => setPageError('')} />}

      {notice && <AdminNotice kind="success" message={notice} onDismiss={() => setNotice('')} />}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[260px]">
          <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--muted2)]" aria-hidden="true" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search a name or an email"
            className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] pl-10 pr-4 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
          />
        </div>
        <div className="flex items-center gap-2">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => { setRoleFilter(t.key); setPage(1); setPending(null); }}
              className={roleFilter === t.key ? filterOn : filterOff}
            >
              {t.label}
              <span className={`ml-1 tabular-nums font-medium ${roleFilter === t.key ? 'text-white/70' : 'text-[var(--muted2)]'}`}>
                ({t.count})
              </span>
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-[68px] rounded-card border border-[var(--border)] bg-[var(--card)] animate-pulse" />
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">
            {search ? 'Nothing matches that search' : roleFilter === 'ADMIN' ? 'You are the only admin' : 'No one to show'}
          </p>
          <p className="text-caption text-[var(--muted)] mt-1">
            {search ? 'Try a different name or email.' : 'Switch to Students to give someone admin access.'}
          </p>
        </div>
      ) : (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <table className="w-full">
            <thead>
              {/* Lower case, and no "#" column: that was the row's position in
                  the list, not anything about the person. */}
              <tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium w-28">Role</th>
                {/* No Status column. It read "Verified" on every row, because
                    an unverified account cannot log in and an admin is
                    verified by definition. The one case worth knowing about
                    is marked under the name instead. */}
                {/* The only column worth ordering by: a date range is a
                    reporting question, but "who joined last" is an admin
                    one. Name and email have the search box instead. */}
                <th className="px-4 py-3 font-medium w-32">
                  <button
                    type="button"
                    onClick={() => {
                      setSort(s => (s === 'JOINED_DESC' ? 'JOINED_ASC' : 'JOINED_DESC'));
                      setPage(1); setPending(null);
                    }}
                    aria-label={sort === 'JOINED_DESC' ? 'Sorted newest first. Sort oldest first' : 'Sorted oldest first. Sort newest first'}
                    className="inline-flex items-center gap-1.5 font-medium text-[var(--muted)] hover:text-[var(--text)] transition-colors"
                  >
                    Joined
                    <i className={`fas ${sort === 'JOINED_DESC' ? 'fa-arrow-down' : 'fa-arrow-up'} text-[10px]`} aria-hidden="true" />
                  </button>
                </th>
                <th className="px-6 py-3 font-medium w-[300px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {paged.map(u => {
                const self  = isSelf(u);
                const admin = u.role === 'ADMIN';
                return (
                  <tr key={u.id} className="hover:bg-[var(--surface)] transition-colors">
                    <td className="px-6 py-4">
                      <p className="text-label font-semibold text-[var(--text)] truncate">
                        {u.name}
                        {self && <span className="ml-2 text-[11px] font-medium text-[var(--muted)]">(you)</span>}
                      </p>
                      <p className="text-caption text-[var(--muted)] truncate">{u.email}</p>
                      {!u.isVerified && (
                        /* They registered and never entered the code, so they
                           cannot log in. Worth seeing; nothing to do about it
                           from here. */
                        <p className="text-caption text-[var(--gold)] mt-0.5">Not verified</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-caption text-[var(--muted)]">{admin ? 'Admin' : 'Student'}</td>
                    <td className="px-4 py-4 text-caption text-[var(--muted)]">
                      {new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      {self ? (
                        /* You cannot change or remove your own account. The server
                           refuses it as well; saying so here is clearer than
                           offering a button that always errors. */
                        <span className="text-caption text-[var(--muted2)]">Your account</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setPending({ user: u, kind: 'role' }); setPageError(''); }}
                            disabled={updatingId === u.id}
                            className={outlineBtn}
                          >
                            {admin ? 'Remove Admin Role' : 'Give Admin Role'}
                          </button>
                          <button
                            onClick={() => { setPending({ user: u, kind: 'delete' }); setPageError(''); }}
                            className={outlineBtn}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Paging stays in the card, because those controls act on the
              table. A bare count does not: inside the white it reads as one
              more row of people. */}
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-t border-[var(--border)]">
              <span className="text-caption text-[var(--muted)] tabular-nums">
                Page {safePage} of {totalPages} · {countLabel}
              </span>
              <div className="flex gap-2">
                <button onClick={() => { setPage(p => Math.max(1, p - 1)); setPending(null); }} disabled={safePage === 1} className={outlineBtn}>
                  Previous
                </button>
                <button onClick={() => { setPage(p => Math.min(totalPages, p + 1)); setPending(null); }} disabled={safePage === totalPages} className={outlineBtn}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {totalPages === 1 && (
        <p className="text-caption text-[var(--muted)] mt-3 tabular-nums">{countLabel}</p>
      )}

      {invitations.length > 0 && (
        /* People who have been invited but have not signed up yet. They are
           not accounts, so they cannot sit in the table above: a row there
           would imply something exists that does not. */
        <div className="mt-4">
          <h2 className="text-label font-semibold text-[var(--text)] mb-1">Invited, not signed up yet</h2>
          <p className="text-caption text-[var(--muted)] mb-3">
            Each becomes an administrator when they sign up with that address. Cancelling stops that; they sign
            up as a student instead.
          </p>
          <div className="rounded-card border border-[var(--border)] bg-[var(--card)] overflow-hidden">
            <ul className="divide-y divide-[var(--border)]">
              {invitations.map(i => (
                <li key={i.id} className="flex items-center justify-between gap-4 px-6 py-3.5">
                  <div className="min-w-0">
                    <p className="text-label text-[var(--text)] truncate">{i.email}</p>
                    <p className="text-caption text-[var(--muted)] mt-0.5">
                      {i.invitedByName ? `Invited by ${i.invitedByName}` : 'Invited'}
                      {' · '}
                      {i.status === 'EXPIRED'
                        ? <span className="text-[var(--gold)]">Expired</span>
                        : `expires ${new Date(i.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                    </p>
                  </div>
                  <button onClick={() => { void withdrawInvite(i.id); }} className={outlineBtn}>
                    Cancel Invitation
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {inviteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(22,26,31,0.45)] p-4"
          role="dialog" aria-modal="true"
          onClick={() => setInviteOpen(false)}
        >
          <form
            className="w-full max-w-[460px] rounded-card border border-[var(--border)] bg-[var(--card)] p-7 shadow-[0_16px_48px_rgba(22,26,31,0.18)]"
            onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); void submitInvite(); }}
          >
            <h2 className="text-h3 font-semibold text-[var(--text)]">Invite an administrator</h2>
            <p className="text-label text-[var(--muted)] mt-2 leading-relaxed">
              If this address already has an account, it gets the admin role straight away. If not, we email an
              invitation and the role is applied when they sign up.
            </p>
            <label htmlFor="invite-email" className="block text-caption font-semibold text-[var(--text)] mt-5 mb-1.5">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              required
              autoFocus
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="name@university.edu"
              className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
            />
            <p className="text-caption text-[var(--muted)] mt-2">
              An administrator can read every student&apos;s questions and change the course material.
            </p>
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                type="submit"
                disabled={inviting || !inviteEmail.trim()}
                className={btnPrimary}
              >
                {inviting ? 'Sending…' : 'Send Invitation'}
              </button>
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(22,26,31,0.45)] p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPending(null)}
        >
          <div
            className="w-full max-w-[460px] rounded-card border border-[var(--border)] bg-[var(--card)] p-7 shadow-[0_16px_48px_rgba(22,26,31,0.18)]"
            onClick={e => e.stopPropagation()}
          >
            {pending.kind === 'delete' ? (
              <>
                <h2 className="text-h3 font-semibold text-[var(--text)]">Delete {pending.user.name}?</h2>
                <p className="text-label text-[var(--muted)] mt-2 leading-relaxed">
                  Their questions and chat history are deleted with them, and they cannot log in again. This cannot be undone.
                </p>
              </>
            ) : pending.user.role === 'ADMIN' ? (
              <>
                <h2 className="text-h3 font-semibold text-[var(--text)]">Remove {pending.user.name} as admin?</h2>
                <p className="text-label text-[var(--muted)] mt-2 leading-relaxed">
                  They become a student again and lose access to this console. Their account stays.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-h3 font-semibold text-[var(--text)]">Make {pending.user.name} an admin?</h2>
                <p className="text-label text-[var(--muted)] mt-2 leading-relaxed">
                  Admins can read every student&apos;s questions, upload lecture material and delete accounts.
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-2 mt-5">
              <button
                type="button"
                disabled={deleting || updatingId === pending.user.id}
                onClick={() => {
                  if (pending.kind === 'delete') void confirmDelete(pending.user);
                  else void confirmRole(pending.user);
                }}
                className={btnPrimary}
              >
                {pending.kind === 'delete'
                  ? (deleting ? 'Deleting…' : 'Delete Permanently')
                  : (updatingId === pending.user.id ? 'Saving…' : pending.user.role === 'ADMIN' ? 'Remove Admin Role' : 'Give Admin Role')}
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
