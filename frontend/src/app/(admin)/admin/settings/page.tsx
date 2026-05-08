'use client';
import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useAuth } from '@/hooks/useAuth';
import { UPDATE_ADMIN_PROFILE_MUTATION } from '@/graphql/admin.mutations';
import { cn } from '@/lib/cn';

const FIELD = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

export default function AdminSettingsPage() {
  const { user, setUser, logout } = useAuth();
  const [updateProfile, { loading }] = useMutation(UPDATE_ADMIN_PROFILE_MUTATION);

  const [activeTab,       setActiveTab]       = useState<'profile' | 'security'>('profile');
  const [confirmLogout,   setConfirmLogout]   = useState(false);
  const [name,            setName]            = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMsg,      setSuccessMsg]      = useState('');
  const [errorMsg,        setErrorMsg]        = useState('');
  const [showCurrent,     setShowCurrent]     = useState(false);
  const [showNew,         setShowNew]         = useState(false);

  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'A';

  const joinedDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg(''); setErrorMsg('');

    if (newPassword && newPassword !== confirmPassword) {
      setErrorMsg('New passwords do not match.'); return;
    }
    if (newPassword && newPassword.length < 8) {
      setErrorMsg('New password must be at least 8 characters.'); return;
    }

    try {
      const { data } = await updateProfile({
        variables: {
          name:            name.trim() !== user?.name ? name.trim() : undefined,
          currentPassword: currentPassword || undefined,
          newPassword:     newPassword     || undefined,
        },
      });
      if (data?.updateAdminProfile) {
        setUser({ ...user!, name: data.updateAdminProfile.name });
      }
      setSuccessMsg('Profile updated successfully.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err: unknown) {
      setErrorMsg(
        (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Update failed.'
      );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white -m-7">

      {/* ── Hero banner — dark admin gradient, matches sidebar palette ── */}
      <div className="relative bg-gradient-to-r from-slate-800 via-slate-700 to-indigo-800 overflow-hidden">
        {/* Decorative blobs */}
        <div className="absolute -top-10 -right-10 w-56 h-56 rounded-full bg-white/5" />
        <div className="absolute bottom-0 left-1/3 w-40 h-40 rounded-full bg-white/5" />

        {/* Sign out — top-right, always visible in banner */}
        <div className="absolute top-4 right-5">
          <button
            type="button"
            onClick={() => { if (!confirmLogout) { setConfirmLogout(true); return; } logout(); }}
            onBlur={() => setConfirmLogout(false)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold transition-all active:scale-95',
              confirmLogout
                ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg'
                : 'bg-white/15 text-white border border-white/25 hover:bg-white/25 backdrop-blur-sm'
            )}
          >
            <i className="fas fa-right-from-bracket text-[11px]" />
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
            { key: 'profile',  label: 'Profile',  icon: 'fa-user' },
            { key: 'security', label: 'Security', icon: 'fa-shield-halved' },
          ] as const).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
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
      <form onSubmit={handleSubmit}>
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

          {activeTab === 'security' && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <i className="fas fa-lock text-white text-[11px]" />
                </div>
                <span className="text-[14px] font-semibold text-slate-700">Change Password</span>
              </div>
              <div className="p-6 flex flex-col gap-5">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
                  <i className="fas fa-circle-info text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-[12px] text-amber-700 leading-relaxed">
                    Leave these fields blank if you only want to update your profile info. Minimum 8 characters.
                  </p>
                </div>

                {[
                  { label: 'Current Password', value: currentPassword, setter: setCurrentPassword, show: showCurrent, toggle: () => setShowCurrent(v => !v), placeholder: 'Your current password' },
                  { label: 'New Password',      value: newPassword,     setter: setNewPassword,     show: showNew,     toggle: () => setShowNew(v => !v),     placeholder: 'Min. 8 characters'     },
                ].map(({ label, value, setter, show, toggle, placeholder }) => (
                  <div key={label}>
                    <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{label}</label>
                    <div className="relative">
                      <input
                        type={show ? 'text' : 'password'}
                        value={value}
                        onChange={e => setter(e.target.value)}
                        className={cn(FIELD, 'pr-10')}
                        placeholder={placeholder}
                      />
                      <button type="button" onClick={toggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[12px]">
                        <i className={cn('fas', show ? 'fa-eye-slash' : 'fa-eye')} />
                      </button>
                    </div>
                  </div>
                ))}

                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className={cn(FIELD, confirmPassword && confirmPassword !== newPassword ? 'border-red-300 focus:border-red-400 focus:ring-red-100' : '')}
                    placeholder="Repeat new password"
                  />
                  {confirmPassword && confirmPassword !== newPassword && (
                    <p className="text-[11px] text-red-500 mt-1.5 flex items-center gap-1">
                      <i className="fas fa-circle-exclamation text-[10px]" /> Passwords do not match
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Feedback */}
          {successMsg && (
            <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3.5 text-[13px] text-emerald-800">
              <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                <i className="fas fa-circle-check text-emerald-600 text-[12px]" />
              </div>
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3.5 text-[13px] text-red-700">
              <div className="w-7 h-7 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
                <i className="fas fa-circle-exclamation text-red-600 text-[12px]" />
              </div>
              {errorMsg}
            </div>
          )}

          {/* Save button */}
          <button
            type="submit"
            disabled={loading}
            className="self-start flex items-center gap-2 px-7 py-3 bg-indigo-600 text-white rounded-xl text-[14px] font-semibold hover:bg-indigo-700 active:scale-95 disabled:opacity-60 transition-all shadow-sm shadow-indigo-200"
          >
            {loading
              ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
              : <><i className="fas fa-check text-[12px]" /> Save Changes</>
            }
          </button>

        </div>
      </form>
    </div>
  );
}
