'use client';
import { useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { authApi } from '@/lib/api';
import { cn } from '@/lib/cn';

const FIELD = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

export default function ProfilePage() {
  const { user, setUser, logout } = useAuth();

  const [name,            setName]            = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMsg,      setSuccessMsg]      = useState('');
  const [errorMsg,        setErrorMsg]        = useState('');
  const [saving,          setSaving]          = useState(false);
  const [showCurrent,     setShowCurrent]     = useState(false);
  const [showNew,         setShowNew]         = useState(false);
  const [avatarPreview,   setAvatarPreview]   = useState<string | null>(user?.avatar_url ?? null);
  const [avatarBase64,    setAvatarBase64]    = useState<string | null>(null);
  const [confirmLogout,   setConfirmLogout]   = useState(false);
  const [activeTab,       setActiveTab]       = useState<'profile' | 'security'>('profile');

  const fileRef = useRef<HTMLInputElement>(null);
  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErrorMsg('Image must be smaller than 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const result = ev.target?.result as string;
      setAvatarPreview(result);
      setAvatarBase64(result);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg(''); setErrorMsg('');

    if (newPassword && newPassword !== confirmPassword) {
      setErrorMsg('New passwords do not match.'); return;
    }
    if (newPassword && newPassword.length < 8) {
      setErrorMsg('New password must be at least 8 characters.'); return;
    }

    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      if (name.trim() && name.trim() !== user?.name) payload.name = name.trim();
      if (avatarBase64) payload.avatarUrl = avatarBase64;
      if (newPassword) { payload.currentPassword = currentPassword; payload.newPassword = newPassword; }

      const res = await authApi.updateProfile(payload);
      const updated = res.data?.data;
      if (updated) {
        setUser({ ...user!, name: updated.name, avatar_url: updated.avatar_url });
      }
      setSuccessMsg('Profile updated successfully.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setAvatarBase64(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message ?? 'Update failed. Please try again.';
      setErrorMsg(msg);
    } finally {
      setSaving(false);
    }
  };

  const joinedDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">

      {/* ── Hero banner ── */}
      <div className="relative bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 overflow-hidden">
        {/* decorative blobs */}
        <div className="absolute -top-10 -right-10 w-56 h-56 rounded-full bg-white/5" />
        <div className="absolute bottom-0 left-1/3 w-40 h-40 rounded-full bg-white/5" />

        {/* Sign out — top-right of banner, always visible */}
        <div className="absolute top-4 right-4 sm:top-5 sm:right-6">
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
          {/* Avatar */}
          <div className="relative shrink-0 group cursor-pointer" onClick={() => fileRef.current?.click()}>
            {avatarPreview ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={avatarPreview}
                alt="Profile"
                className="w-24 h-24 rounded-3xl object-cover border-4 border-white/30 shadow-2xl"
              />
            ) : (
              <div className="w-24 h-24 rounded-3xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-white text-3xl font-bold border-4 border-white/30 shadow-2xl">
                {initials}
              </div>
            )}
            <div className="absolute inset-0 rounded-3xl flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="flex flex-col items-center gap-1 text-white">
                <i className="fas fa-camera text-lg" />
                <span className="text-[11px] font-semibold">Change</span>
              </div>
            </div>
            <div className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-xl bg-indigo-400 border-2 border-white flex items-center justify-center shadow">
              <i className="fas fa-pen text-white text-[9px]" />
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarChange} />

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl font-extrabold text-white truncate">{user?.name}</h1>
              <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/20 text-white border border-white/30 uppercase tracking-widest">
                Student
              </span>
            </div>
            <p className="text-indigo-100 text-sm mt-0.5 truncate">{user?.email}</p>
            {joinedDate && (
              <p className="text-indigo-200 text-xs mt-2 flex items-center gap-1.5">
                <i className="fas fa-calendar-days" />
                Member since {joinedDate}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab bar (floats over banner bottom) ── */}
      <div className="sticky top-14 z-20 max-w-3xl mx-auto px-6">
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
      <form onSubmit={handleSave}>
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

                  {/* Avatar upload row */}
                  <div className="flex items-center gap-5 p-4 rounded-xl bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100">
                    <div className="relative shrink-0 group cursor-pointer" onClick={() => fileRef.current?.click()}>
                      {avatarPreview ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={avatarPreview} alt="Profile" className="w-16 h-16 rounded-2xl object-cover border-2 border-indigo-200" />
                      ) : (
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-xl font-bold border-2 border-indigo-200">
                          {initials}
                        </div>
                      )}
                      <div className="absolute inset-0 rounded-2xl flex items-center justify-center bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity">
                        <i className="fas fa-camera text-white text-sm" />
                      </div>
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-800">Profile photo</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">JPG, PNG or WebP · max 2 MB</p>
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-600 hover:text-indigo-700 transition-colors"
                      >
                        <i className="fas fa-upload text-[10px]" />
                        Upload new photo
                      </button>
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
                      placeholder="Your full name"
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

              {/* Account details card */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                  <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center">
                    <i className="fas fa-circle-info text-white text-[11px]" />
                  </div>
                  <span className="text-[14px] font-semibold text-slate-700">Account Details</span>
                </div>
                <div className="p-6 grid grid-cols-2 gap-4">
                  {[
                    { label: 'Role',          value: 'Student',   icon: 'fa-graduation-cap', color: 'indigo' },
                    { label: 'Member Since',  value: joinedDate ?? '—', icon: 'fa-calendar-check', color: 'emerald' },
                    { label: 'Account Type',  value: 'Standard',  icon: 'fa-id-badge',       color: 'violet' },
                    { label: 'Status',        value: 'Active',    icon: 'fa-circle-check',   color: 'green' },
                  ].map(item => (
                    <div key={item.label} className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                        item.color === 'indigo'  && 'bg-indigo-100',
                        item.color === 'emerald' && 'bg-emerald-100',
                        item.color === 'violet'  && 'bg-violet-100',
                        item.color === 'green'   && 'bg-green-100',
                      )}>
                        <i className={cn(
                          'fas text-[12px]', item.icon,
                          item.color === 'indigo'  && 'text-indigo-600',
                          item.color === 'emerald' && 'text-emerald-600',
                          item.color === 'violet'  && 'text-violet-600',
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
                    Leave these fields blank if you only want to update your profile info. A strong password is at least 8 characters.
                  </p>
                </div>

                {[
                  { label: 'Current Password', value: currentPassword, setter: setCurrentPassword, show: showCurrent, toggle: () => setShowCurrent(v => !v), placeholder: 'Your current password' },
                  { label: 'New Password',      value: newPassword,     setter: setNewPassword,     show: showNew,     toggle: () => setShowNew(v => !v),     placeholder: 'Min. 8 characters' },
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
          <div className="flex items-center justify-between gap-4">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-7 py-3 bg-indigo-600 text-white rounded-xl text-[14px] font-semibold hover:bg-indigo-700 active:scale-95 disabled:opacity-60 transition-all shadow-sm shadow-indigo-200"
            >
              {saving
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                : <><i className="fas fa-check text-[12px]" /> Save Changes</>
              }
            </button>
          </div>

        </div>
      </form>
    </div>
  );
}
