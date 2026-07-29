'use client';
import { useState, useCallback, useEffect } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { UPDATE_ADMIN_PROFILE_MUTATION } from '@/graphql/admin.mutations';
import { GET_LECTURE_AGENT_DETAILS } from '@/graphql/admin.queries';
import { cn } from '@/lib/cn';

const FIELD = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

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
    { label: 'One uppercase letter',      met: /[A-Z]/.test(newPassword)                  },
    { label: 'One number',               met: /[0-9]/.test(newPassword)                  },
    { label: 'One special character',    met: /[^A-Za-z0-9]/.test(newPassword)           },
  ];
  const pwdStrength  = pwdRules.filter(r => r.met).length;
  const allRulesMet  = pwdRules.every(r => r.met);
  const pwdMatch     = confirmPassword === newPassword;

  const strengthColors = ['bg-slate-200', 'bg-red-500', 'bg-amber-500', 'bg-yellow-400', 'bg-emerald-500'];
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
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white -m-7">

      {/* ── Hero banner — dark admin gradient, matches sidebar palette ── */}
      <div className="relative bg-gradient-to-r from-slate-800 via-slate-700 to-indigo-800 overflow-hidden">
        {/* Decorative blobs */}
        <div className="absolute -top-10 -right-10 w-56 h-56 rounded-full bg-white/5" />
        <div className="absolute bottom-0 left-1/3 w-40 h-40 rounded-full bg-white/5" />

        {/* Top-right: Notification bell + Sign out */}
        <div className="absolute top-4 right-5 flex items-center gap-2.5">

          {/* Notification Bell */}
          <div className="relative">
            <button
              type="button"
              onClick={() => notifOpen ? setNotifOpen(false) : openNotif()}
              className="relative w-11 h-11 rounded-xl bg-white/15 border border-white/25 hover:bg-white/25 backdrop-blur-sm flex items-center justify-center transition-all"
            >
              <i className="fas fa-bell text-white text-xl" />
              {notifCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {notifCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} />
                <div className="absolute right-0 top-13 w-80 bg-white rounded-2xl border border-slate-200 shadow-2xl z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-[14px] font-bold text-slate-800 flex items-center gap-2">
                      <i className="fas fa-bell text-indigo-500" /> Notifications
                      {notifCount > 0 && (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">{notifCount} alert{notifCount !== 1 ? 's' : ''}</span>
                      )}
                    </span>
                    <button onClick={() => setNotifOpen(false)} className="text-slate-400 hover:text-slate-600 text-[14px]">
                      <i className="fas fa-xmark" />
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-50">
                    {unseenAgents.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <i className="fas fa-bell-slash text-slate-300 text-3xl mb-3 block" />
                        <p className="text-[14px] font-semibold text-slate-600">No recent notifications</p>
                        <p className="text-[12px] text-slate-400 mt-1">You're all caught up</p>
                      </div>
                    ) : (
                      unseenAgents.map(a => (
                        <Link key={a.id} href={`/admin/lectures/${a.id}`} onClick={() => setNotifOpen(false)}
                          className="flex items-start gap-3 px-4 py-3.5 hover:bg-slate-50 transition-colors">
                          <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
                            <i className="fas fa-circle-exclamation text-red-500 text-[15px]" />
                          </div>
                          <div>
                            <p className="text-[14px] font-semibold text-slate-800">Embedding Failed</p>
                            <p className="text-[12px] text-slate-500 mt-0.5 line-clamp-1">{a.title}</p>
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
              'flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all active:scale-95',
              confirmLogout
                ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg'
                : 'bg-white/15 text-white border border-white/25 hover:bg-white/25 backdrop-blur-sm'
            )}
          >
            <i className="fas fa-right-from-bracket text-[12px]" />
            {confirmLogout ? 'Yes, sign me out' : 'Sign Out'}
          </button>
        </div>

        <div className="relative max-w-3xl mx-auto px-6 pt-10 pb-16 flex items-center gap-6">
          {/* Avatar — initials only for admin (no upload) */}
          <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-3xl font-bold border-4 border-white/20 shadow-2xl shrink-0">
            {initials}
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl font-extrabold text-white truncate">{user?.name}</h1>
              <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-violet-500/30 text-violet-200 border border-violet-400/30 uppercase tracking-widest">
                Admin
              </span>
            </div>
            <p className="text-slate-300 text-sm mt-0.5 truncate">{user?.email}</p>
            {joinedDate && (
              <p className="text-slate-400 text-xs mt-2 flex items-center gap-1.5">
                <i className="fas fa-calendar-days" />
                Member since {joinedDate}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab bar — floats over banner bottom ── */}
      <div className="sticky top-0 z-20 max-w-3xl mx-auto px-6">
        <div className="flex gap-1 bg-white rounded-2xl shadow-lg border border-slate-200 p-1.5 -mt-6">
          {([
            { key: 'profile',  label: 'Profile',         icon: 'fa-user' },
            { key: 'password', label: 'Change Password',  icon: 'fa-lock' },
          ] as const).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setActiveTab(t.key); setSuccessMsg(''); setErrorMsg(''); }}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold transition-all',
                activeTab === t.key
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
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
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                  <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                    <i className="fas fa-id-card text-white text-[11px]" />
                  </div>
                  <span className="text-[14px] font-semibold text-slate-700">Personal Information</span>
                </div>
                <div className="p-6 flex flex-col gap-5">

                  {/* Avatar preview row */}
                  <div className="flex items-center gap-5 p-4 rounded-xl bg-gradient-to-r from-slate-50 to-indigo-50 border border-slate-200">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-xl font-bold border-2 border-indigo-200 shrink-0">
                      {(name || user?.name || 'A').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-800">Admin avatar</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">Generated from your display name initial.</p>
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
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
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <input value={user?.email ?? ''} disabled className={cn(FIELD, 'opacity-60 cursor-not-allowed pr-10')} />
                      <i className="fas fa-lock absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[11px]" />
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1.5">Email address cannot be changed.</p>
                  </div>
                </div>
              </div>

              {/* Account details grid */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                  <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center">
                    <i className="fas fa-circle-info text-white text-[11px]" />
                  </div>
                  <span className="text-[14px] font-semibold text-slate-700">Account Details</span>
                </div>
                <div className="p-6 grid grid-cols-2 gap-4">
                  {[
                    { label: 'Role',         value: 'Administrator', icon: 'fa-user-shield',     color: 'violet'  },
                    { label: 'Member Since', value: joinedDate ?? '—', icon: 'fa-calendar-check', color: 'emerald' },
                    { label: 'Access Level', value: 'Full Access',   icon: 'fa-key',              color: 'indigo'  },
                    { label: 'Status',       value: 'Active',        icon: 'fa-circle-check',     color: 'green'   },
                  ].map(item => (
                    <div key={item.label} className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                        item.color === 'violet'  && 'bg-violet-100',
                        item.color === 'emerald' && 'bg-emerald-100',
                        item.color === 'indigo'  && 'bg-indigo-100',
                        item.color === 'green'   && 'bg-green-100',
                      )}>
                        <i className={cn(
                          'fas text-[12px]', item.icon,
                          item.color === 'violet'  && 'text-violet-600',
                          item.color === 'emerald' && 'text-emerald-600',
                          item.color === 'indigo'  && 'text-indigo-600',
                          item.color === 'green'   && 'text-green-600',
                        )} />
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{item.label}</p>
                        <p className="text-[13px] font-semibold text-slate-800 mt-0.5">{item.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === 'password' && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <i className="fas fa-lock text-white text-[11px]" />
                </div>
                <span className="text-[14px] font-semibold text-slate-700">Change Password</span>
              </div>
              <div className="p-6 flex flex-col gap-5">

                {/* Current Password */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Current Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-lock absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[11px]" />
                    <input
                      type={showCurrent ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={e => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                      className={cn(FIELD, 'pl-9 pr-10')}
                      placeholder="Enter your current password"
                    />
                    <button type="button" onClick={() => setShowCurrent(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[12px]">
                      <i className={cn('fas', showCurrent ? 'fa-eye-slash' : 'fa-eye')} />
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5 flex items-center gap-1">
                    <i className="fas fa-circle-info text-[10px]" /> Required to verify your identity before changing password
                  </p>
                </div>

                {/* New Password + Strength */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    New Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-key absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[11px]" />
                    <input
                      type={showNew ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      className={cn(
                        FIELD, 'pl-9 pr-10',
                        newPassword && !allRulesMet ? 'border-amber-300 focus:border-amber-400 focus:ring-amber-100' : '',
                        newPassword && allRulesMet  ? 'border-emerald-300 focus:border-emerald-400 focus:ring-emerald-100' : '',
                      )}
                      placeholder="Create a strong password"
                    />
                    <button type="button" onClick={() => setShowNew(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[12px]">
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
                              'h-1.5 flex-1 rounded-full transition-all duration-300',
                              i <= pwdStrength ? strengthColors[pwdStrength] : 'bg-slate-200'
                            )}
                          />
                        ))}
                      </div>
                      <p className={cn(
                        'text-[11px] font-semibold',
                        pwdStrength <= 1 ? 'text-red-500' : pwdStrength === 2 ? 'text-amber-500' : pwdStrength === 3 ? 'text-yellow-600' : 'text-emerald-600'
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
                        rule.met ? 'text-emerald-600' : 'text-slate-400'
                      )}>
                        <i className={cn('fas text-[10px]', rule.met ? 'fa-circle-check text-emerald-500' : 'fa-circle text-slate-300')} />
                        {rule.label}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Confirm New Password */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Confirm New Password
                  </label>
                  <div className="relative">
                    <i className="fas fa-shield-check absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[11px]" />
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      className={cn(
                        FIELD, 'pl-9 pr-10',
                        confirmPassword && !pwdMatch ? 'border-red-300 focus:border-red-400 focus:ring-red-100' : '',
                        confirmPassword && pwdMatch  ? 'border-emerald-300 focus:border-emerald-400 focus:ring-emerald-100' : '',
                      )}
                      placeholder="Re-enter your new password"
                    />
                    <button type="button" onClick={() => setShowConfirm(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[12px]">
                      <i className={cn('fas', showConfirm ? 'fa-eye-slash' : 'fa-eye')} />
                    </button>
                  </div>
                  {confirmPassword && (
                    <p className={cn('text-[11px] mt-1.5 flex items-center gap-1', pwdMatch ? 'text-emerald-600' : 'text-red-500')}>
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
            className="self-start flex items-center gap-2 px-7 py-3 bg-indigo-600 text-white rounded-xl text-[14px] font-semibold hover:bg-indigo-700 active:scale-95 disabled:opacity-60 transition-all shadow-sm shadow-indigo-200"
          >
            {loading
              ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
              : <><i className="fas fa-check text-[12px]" /> Save Changes</>
            }
          </button>

        </div>
      </div>

      {/* Toast notifications */}
      {(successMsg || errorMsg) && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-2xl shadow-xl animate-fade-in ${
          successMsg ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <i className={`fas ${successMsg ? 'fa-circle-check' : 'fa-circle-exclamation'} text-[18px]`} />
          <div>
            <p className="text-[14px] font-bold leading-none">{successMsg ? 'Success' : 'Error'}</p>
            <p className="text-[12px] mt-0.5 opacity-90">{successMsg || errorMsg}</p>
          </div>
          <button
            onClick={() => { setSuccessMsg(''); setErrorMsg(''); }}
            className="ml-2 opacity-70 hover:opacity-100 transition-opacity"
          >
            <i className="fas fa-xmark text-[14px]" />
          </button>
        </div>
      )}
    </div>
  );
}
