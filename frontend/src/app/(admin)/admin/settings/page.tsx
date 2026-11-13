'use client';
import { useState, useCallback, useEffect } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { UPDATE_ADMIN_PROFILE_MUTATION } from '@/graphql/admin.mutations';
import { GET_LECTURE_AGENT_DETAILS } from '@/graphql/admin.queries';
import { cn } from '@/lib/cn';

const FIELD = 'w-full px-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-card text-label text-[var(--text)] outline-none focus:border-[var(--accent)] focus:bg-[var(--card)] transition-colors placeholder:text-[var(--muted2)]';

export default function AdminSettingsPage() {
  const { user, setUser, logout } = useAuth();
  const [updateProfile, { loading }] = useMutation(UPDATE_ADMIN_PROFILE_MUTATION);

  const [activeTab,       setActiveTab]       = useState<'profile' | 'password'>('profile');
  const [confirmLogout,   setConfirmLogout]   = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const { data: agentData } = useQuery(GET_LECTURE_AGENT_DETAILS, { fetchPolicy: 'network-only' });
  const allFailed: { id: number; title: string }[] = (agentData?.lectureAgentDetails ?? []).filter((a: { status: string }) => a.status === 'FAILED');

  // Seen IDs persisted in localStorage — once seen, never shown again unless new failures appear
  const getSeenIds = (): number[] => {
    try { return JSON.parse(localStorage.getItem('askaitutor_seen_notifs') ?? '[]'); } catch { return []; }
  };
  const unseenAgents = allFailed.filter(a => !getSeenIds().includes(a.id));
  const notifCount   = unseenAgents.length;

  const openNotif = useCallback(() => {
    // Mark all currently unseen as seen when dropdown is opened
    const seenIds = getSeenIds();
    const merged  = Array.from(new Set([...seenIds, ...allFailed.map(a => a.id)]));
    localStorage.setItem('askaitutor_seen_notifs', JSON.stringify(merged));
    setNotifOpen(true);
  }, [allFailed]);
  const [name,            setName]            = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMsg,      setSuccessMsg]      = useState('');
  const [errorMsg,        setErrorMsg]        = useState('');
  const [showCurrent,     setShowCurrent]     = useState(false);
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);

  useEffect(() => {
    if (!successMsg && !errorMsg) return;
    const t = setTimeout(() => { setSuccessMsg(''); setErrorMsg(''); }, 3500);
    return () => clearTimeout(t);
  }, [successMsg, errorMsg]);

  const pwdRules = [
    { label: 'At least 8 characters',    met: newPassword.length >= 8                    },
    { label: 'One  letter',      met: /[A-Z]/.test(newPassword)                  },
    { label: 'One number',               met: /[0-9]/.test(newPassword)                  },
    { label: 'One special character',    met: /[^A-Za-z0-9]/.test(newPassword)           },
  ];
  const pwdStrength  = pwdRules.filter(r => r.met).length;
  const allRulesMet  = pwdRules.every(r => r.met);
  const pwdMatch     = confirmPassword === newPassword;

  const strengthColors = ['bg-[var(--border)]', 'bg-[var(--gold)]', 'bg-[var(--gold)]', 'bg-[var(--gold)]', 'bg-[var(--accent)]'];
  const strengthLabels = ['', 'Weak', 'Fair', 'Good', 'Strong'];

  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'A';

  const joinedDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const handleSubmit = async () => {
    setSuccessMsg(''); setErrorMsg('');

    if (activeTab === 'password') {
      if (!currentPassword.trim()) {
        setErrorMsg('Please enter your current password.'); return;
      }
      if (!newPassword.trim()) {
        setErrorMsg('Please enter a new password.'); return;
      }
      if (!allRulesMet) {
        setErrorMsg('New password does not meet all the requirements.'); return;
      }
      if (!confirmPassword.trim()) {
        setErrorMsg('Please confirm your new password.'); return;
      }
      if (!pwdMatch) {
        setErrorMsg('New passwords do not match.'); return;
      }
    }

    try {
      const { data } = await updateProfile({
        variables: {
          name:            activeTab === 'profile' && name.trim() !== user?.name ? name.trim() : undefined,
          currentPassword: activeTab === 'password' ? currentPassword : undefined,
          newPassword:     activeTab === 'password' ? newPassword     : undefined,
        },
      });
      if (data?.updateAdminProfile) {
        setUser({ ...user!, name: data.updateAdminProfile.name });
      }
      setSuccessMsg(activeTab === 'password' ? 'Password changed successfully.' : 'Profile updated successfully.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Update failed.';
      setErrorMsg(msg === 'Current password is incorrect' ? 'Incorrect current password. Please try again.' : msg);
    }
  };

  return (
    <div className="min-h-screen -m-7">

      {/* Hero band, in the same navy as the sidebar. */}
      <div className="relative overflow-hidden bg-[var(--accent-deep)]">

        {/* Top-right: Notification bell + Sign out */}
        <div className="absolute top-4 right-5 flex items-center gap-2.5">

          {/* Notification Bell */}
          <div className="relative">
            <button
              type="button"
              onClick={() => notifOpen ? setNotifOpen(false) : openNotif()}
              className="relative w-11 h-11 rounded-card bg-white/15 border border-white/25 hover:bg-white/25 flex items-center justify-center transition-colors"
            >
              <i className="fas fa-bell text-white text-h2" />
              {notifCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-[var(--gold)] text-white text-[10px] font-semibold rounded-full flex items-center justify-center">
                  {notifCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} />
                <div className="absolute right-0 top-13 w-80 bg-[var(--card)] rounded-card border border-[var(--border)] z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
                    <span className="text-label font-semibold text-[var(--text)] flex items-center gap-2">
                      <i className="fas fa-bell text-[var(--accent)]" /> Notifications
                      {notifCount > 0 && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[var(--gold-soft)] text-[var(--gold)]">{notifCount} alert{notifCount !== 1 ? 's' : ''}</span>
                      )}
                    </span>
                    <button onClick={() => setNotifOpen(false)} className="text-[var(--muted2)] hover:text-[var(--muted)] text-label">
                      <i className="fas fa-xmark" />
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-[var(--border)]">
                    {unseenAgents.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <i className="fas fa-bell-slash text-[var(--muted2)] text-display mb-3 block" />
                        <p className="text-label font-semibold text-[var(--muted)]">No recent notifications</p>
                        <p className="text-caption text-[var(--muted2)] mt-1">You're all caught up</p>
                      </div>
                    ) : (
                      unseenAgents.map(a => (
                        <Link key={a.id} href={`/admin/lectures/${a.id}`} onClick={() => setNotifOpen(false)}
                          className="flex items-start gap-3 px-4 py-3.5 hover:bg-[var(--surface)] transition-colors">
                          <div className="w-9 h-9 rounded-card bg-[var(--gold-soft)] flex items-center justify-center shrink-0 mt-0.5">
                            <i className="fas fa-circle-exclamation text-[var(--gold)] text-label" />
                          </div>
                          <div>
                            <p className="text-label font-semibold text-[var(--text)]">Embedding Failed</p>
                            <p className="text-caption text-[var(--muted)] mt-0.5 line-clamp-1">{a.title}</p>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Sign out */}
          <button
            type="button"
            onClick={() => { if (!confirmLogout) { setConfirmLogout(true); return; } logout(); }}
            onBlur={() => setConfirmLogout(false)}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-card text-caption font-semibold transition-colors active:scale-95',
              confirmLogout
                ? 'bg-[var(--gold)] text-white hover:bg-[var(--gold)]'
                : 'bg-white/15 text-white border border-white/25 hover:bg-white/25'
            )}
          >
            <i className="fas fa-right-from-bracket text-caption" />
            {confirmLogout ? 'Yes, sign me out' : 'Sign Out'}
          </button>
        </div>

        <div className="relative max-w-3xl mx-auto px-6 pt-10 pb-16 flex items-center gap-6">
          {/* Avatar — initials only for admin (no upload) */}
          <div className="w-24 h-24 rounded-card bg-white/12 flex items-center justify-center text-white text-display font-semibold border border-white/25 shrink-0">
            {initials}
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-h1 font-semibold text-white truncate">{user?.name}</h1>
              <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-white/15 text-white border border-white/25">
                Admin
              </span>
            </div>
            <p className="text-[var(--accent-dim)] text-label mt-0.5 truncate">{user?.email}</p>
            {joinedDate && (
              <p className="text-[var(--accent-dim)] text-caption mt-2 flex items-center gap-1.5">
                <i className="fas fa-calendar-days" />
                Member since {joinedDate}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab bar — floats over banner bottom ── */}
      <div className="sticky top-0 z-20 max-w-3xl mx-auto px-6">
        <div className="flex gap-1 bg-[var(--card)] rounded-card border border-[var(--border)] p-1.5 -mt-6">
          {([
            { key: 'profile',  label: 'Profile',         icon: 'fa-user' },
            { key: 'password', label: 'Change Password',  icon: 'fa-lock' },
          ] as const).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setActiveTab(t.key); setSuccessMsg(''); setErrorMsg(''); }}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-card text-caption font-semibold transition-colors',
                activeTab === t.key
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]'
              )}
            >
              <i className={cn('fas', t.icon, 'text-[11px]')} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main content ── */}
      <div>
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-5">

          {activeTab === 'profile' && (
            <>
              {/* Profile info card */}
              <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-[var(--border)] bg-[var(--surface)]">
                  <div className="w-7 h-7 rounded-card bg-[var(--accent)] flex items-center justify-center">
                    <i className="fas fa-id-card text-white text-[11px]" />
                  </div>
                  <span className="text-label font-semibold text-[var(--text)]">Personal Information</span>
                </div>
                <div className="p-6 flex flex-col gap-5">

                  {/* Avatar preview row */}
                  <div className="flex items-center gap-5 p-4 rounded-card bg-[var(--surface)] border border-[var(--border)]">
                    <div className="w-16 h-16 rounded-card bg-[var(--accent)] flex items-center justify-center text-white text-h2 font-semibold shrink-0">
                      {(name || user?.name || 'A').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-caption font-semibold text-[var(--text)]">Admin avatar</p>
                      <p className="text-[11px] text-[var(--muted)] mt-0.5">Generated from your display name initial.</p>
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--muted)] mb-1.5">
                      Display Name
                    </label>
                    <input
                      value={name}
                      onChange={e => setName(e.target.value)}
                      className={FIELD}
                      placeholder="Your name"
                    />
                  </div>

                  {/* Email (read-only) */}
                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--muted)] mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <input value={user?.email ?? ''} disabled className={cn(FIELD, 'opacity-60 cursor-not-allowed pr-10')} />
                      <i className="fas fa-lock absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-[11px]" />
                    </div>
                    <p className="text-[11px] text-[var(--muted2)] mt-1.5">Email address cannot be changed.</p>
                  </div>
                </div>
              </div>

              {/* Account details grid */}
              <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-[var(--border)] bg-[var(--surface)]">
                  <div className="w-7 h-7 rounded-card bg-[var(--accent)] flex items-center justify-center">
                    <i className="fas fa-circle-info text-white text-[11px]" />
                  </div>
                  <span className="text-label font-semibold text-[var(--text)]">Account Details</span>
                </div>
                <div className="p-6 grid grid-cols-2 gap-4">
                  {[
                    { label: 'Role',         value: 'Administrator', icon: 'fa-user-shield',     color: 'violet'  },
                    { label: 'Member Since', value: joinedDate ?? '—', icon: 'fa-calendar-check', color: 'emerald' },
                    { label: 'Access Level', value: 'Full Access',   icon: 'fa-key',              color: 'indigo'  },
                    { label: 'Status',       value: 'Active',        icon: 'fa-circle-check',     color: 'green'   },
                  ].map(item => (
                    <div key={item.label} className="flex items-start gap-3 p-3.5 rounded-card bg-[var(--surface)] border border-[var(--border)]">
                      <div className={cn(
                        'w-8 h-8 rounded-card flex items-center justify-center shrink-0',
                        item.color === 'violet'  && 'bg-[var(--accent-soft)]',
                        item.color === 'emerald' && 'bg-[var(--accent-soft)]',
                        item.color === 'indigo'  && 'bg-[var(--accent-soft)]',
                        item.color === 'green'   && 'bg-[var(--accent-soft)]',
                      )}>
                        <i className={cn(
                          'fas text-caption', item.icon,
                          item.color === 'violet'  && 'text-[var(--accent)]',
                          item.color === 'emerald' && 'text-[var(--accent)]',
                          item.color === 'indigo'  && 'text-[var(--accent)]',
                          item.color === 'green'   && 'text-[var(--accent)]',
                        )} />
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold text-[var(--muted2)]">{item.label}</p>
                        <p className="text-caption font-semibold text-[var(--text)] mt-0.5">{item.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === 'password' && (
            <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
              <div className="flex items-center gap-2.5 px-6 py-4 border-b border-[var(--border)] bg-[var(--surface)]">
                <div className="w-7 h-7 rounded-card bg-[var(--accent)] flex items-center justify-center">
                  <i className="fas fa-lock text-white text-[11px]" />
                </div>
                <span className="text-label font-semibold text-[var(--text)]">Change Password</span>
              </div>
              <div className="p-6 flex flex-col gap-5">

                {/* Current Password */}
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--muted)] mb-1.5">
                    Current Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-lock absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-[11px]" />
                    <input
                      type={showCurrent ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={e => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                      className={cn(FIELD, 'pl-9 pr-10')}
                      placeholder="Enter your current password"
                    />
                    <button type="button" onClick={() => setShowCurrent(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--muted)] text-caption">
                      <i className={cn('fas', showCurrent ? 'fa-eye-slash' : 'fa-eye')} />
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--muted2)] mt-1.5 flex items-center gap-1">
                    <i className="fas fa-circle-info text-[10px]" /> Required to verify your identity before changing password
                  </p>
                </div>

                {/* New Password + Strength */}
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--muted)] mb-1.5">
                    New Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-key absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-[11px]" />
                    <input
                      type={showNew ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      className={cn(
                        FIELD, 'pl-9 pr-10',
                        newPassword && !allRulesMet ? 'border-[var(--gold)] focus:border-[var(--gold)]' : '',
                        newPassword && allRulesMet  ? 'border-[var(--accent)] focus:border-[var(--accent)]' : '',
                      )}
                      placeholder="Create a strong password"
                    />
                    <button type="button" onClick={() => setShowNew(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--muted)] text-caption">
                      <i className={cn('fas', showNew ? 'fa-eye-slash' : 'fa-eye')} />
                    </button>
                  </div>

                  {/* Strength bar */}
                  {newPassword && (
                    <div className="mt-2.5">
                      <div className="flex gap-1 mb-1.5">
                        {[1,2,3,4].map(i => (
                          <div
                            key={i}
                            className={cn(
                              'h-1.5 flex-1 rounded-full transition-colors duration-300',
                              i <= pwdStrength ? strengthColors[pwdStrength] : 'bg-[var(--border)]'
                            )}
                          />
                        ))}
                      </div>
                      <p className={cn(
                        'text-[11px] font-semibold',
                        pwdStrength <= 1 ? 'text-[var(--gold)]' : pwdStrength === 2 ? 'text-[var(--gold)]' : pwdStrength === 3 ? 'text-[var(--gold)]' : 'text-[var(--accent)]'
                      )}>
                        {strengthLabels[pwdStrength]}
                      </p>
                    </div>
                  )}

                  {/* Rules checklist */}
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    {pwdRules.map(rule => (
                      <div key={rule.label} className={cn(
                        'flex items-center gap-1.5 text-[11px] transition-colors',
                        rule.met ? 'text-[var(--accent)]' : 'text-[var(--muted2)]'
                      )}>
                        <i className={cn('fas text-[10px]', rule.met ? 'fa-circle-check text-[var(--accent)]' : 'fa-circle text-[var(--muted2)]')} />
                        {rule.label}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Confirm New Password */}
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--muted)] mb-1.5">
                    Confirm New Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-shield-check absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-[11px]" />
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      className={cn(
                        FIELD, 'pl-9 pr-10',
                        confirmPassword && !pwdMatch ? 'border-[var(--gold)] focus:border-[var(--gold)]' : '',
                        confirmPassword && pwdMatch  ? 'border-[var(--accent)] focus:border-[var(--accent)]' : '',
                      )}
                      placeholder="Re-enter your new password"
                    />
                    <button type="button" onClick={() => setShowConfirm(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--muted)] text-caption">
                      <i className={cn('fas', showConfirm ? 'fa-eye-slash' : 'fa-eye')} />
                    </button>
                  </div>
                  {confirmPassword && (
                    <p className={cn('text-[11px] mt-1.5 flex items-center gap-1', pwdMatch ? 'text-[var(--accent)]' : 'text-[var(--gold)]')}>
                      <i className={cn('fas text-[10px]', pwdMatch ? 'fa-circle-check' : 'fa-circle-exclamation')} />
                      {pwdMatch ? 'Passwords match' : 'Passwords do not match'}
                    </p>
                  )}
                </div>

              </div>
            </div>
          )}


          {/* Save button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || (activeTab === 'password' && newPassword !== '' && (!allRulesMet || !pwdMatch))}
            className="self-start flex items-center gap-2 px-7 py-3 bg-[var(--accent)] text-white rounded-card text-label font-semibold hover:bg-[var(--accent-deep)] active:scale-95 disabled:opacity-60 transition-colors shadow-indigo-200"
          >
            {loading
              ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
              : <><i className="fas fa-check text-caption" /> Save Changes</>
            }
          </button>

        </div>
      </div>

      {/* Toast notifications */}
      {(successMsg || errorMsg) && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-card  animate-fade-in ${
          successMsg ? 'bg-[var(--accent)] text-white' : 'bg-[var(--gold)] text-white'
        }`}>
          <i className={`fas ${successMsg ? 'fa-circle-check' : 'fa-circle-exclamation'} text-h3`} />
          <div>
            <p className="text-label font-semibold leading-none">{successMsg ? 'Success' : 'Error'}</p>
            <p className="text-caption mt-0.5 opacity-90">{successMsg || errorMsg}</p>
          </div>
          <button
            onClick={() => { setSuccessMsg(''); setErrorMsg(''); }}
            className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
          >
            <i className="fas fa-xmark text-label" />
          </button>
        </div>
      )}
    </div>
  );
}
