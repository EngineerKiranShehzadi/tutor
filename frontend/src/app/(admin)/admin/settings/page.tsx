'use client';
import { useState, useEffect } from 'react';
import { useMutation } from '@apollo/client';
import { useAuth } from '@/hooks/useAuth';
import { UPDATE_ADMIN_PROFILE_MUTATION } from '@/graphql/admin.mutations';
import { AdminNotice } from '@/components/admin/AdminNotice';
import { cn } from '@/lib/cn';
import { fieldLabel } from '@/lib/ui';

/**
 * My Account.
 *
 * The shape here is the one this page always had — a banner carrying who you
 * are, two tabs, and sections beneath. Three things changed.
 *
 * The banner was the same deep navy as the sidebar, so the two met at a seam
 * and read as one block folded at a corner. It is the page surface now, with
 * the navy kept for the avatar alone, where it marks something rather than
 * filling a shape.
 *
 * The section headers carried a navy icon tile each: a square of colour
 * repeating the word next to it. The words stayed, the tiles went.
 *
 * Messages used the shared admin notice rather than a toast in the corner,
 * because every other screen in the console reports success the same way.
 */

const FIELD =
  'w-full h-11 px-3.5 bg-[var(--surface)] border border-[var(--border)] rounded-control text-label ' +
  'text-[var(--text)] outline-none focus:border-[var(--accent)] focus:bg-[var(--card)] ' +
  'transition-colors placeholder:text-caption placeholder:text-[var(--muted2)]';

export default function AdminSettingsPage() {
  const { user, setUser } = useAuth();
  const [updateProfile, { loading }] = useMutation(UPDATE_ADMIN_PROFILE_MUTATION);

  const [activeTab,       setActiveTab]       = useState<'profile' | 'password'>('profile');
  const [name,            setName]            = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMsg,      setSuccessMsg]      = useState('');
  const [errorMsg,        setErrorMsg]        = useState('');
  const [showCurrent,     setShowCurrent]     = useState(false);
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);

  useEffect(() => { if (user?.name) setName(n => (n === '' ? user.name : n)); }, [user?.name]);

  /**
   * The server's rules, and only the server's rules (password-policy.ts):
   * eight characters, an uppercase letter, a number, and a 72-byte ceiling
   * because bcrypt ignores anything past it. The screen used to demand a
   * special character the server does not want and never mentioned the
   * ceiling, so a password could pass every rule here and still be refused.
   */
  const pwdBytes = new TextEncoder().encode(newPassword).length;
  const pwdRules = [
    { label: 'At least 8 characters',   met: newPassword.length >= 8        },
    { label: 'One uppercase letter',    met: /[A-Z]/.test(newPassword)      },
    { label: 'One number',              met: /[0-9]/.test(newPassword)      },
    { label: 'At most 72 characters',   met: pwdBytes > 0 && pwdBytes <= 72 },
  ];
  const allRulesMet = pwdRules.every(r => r.met);
  const pwdMatch    = confirmPassword === newPassword;
  const pwdReused   = newPassword !== '' && newPassword === currentPassword;

  const googleAccount = !!user?.google_id;

  // One rule for the avatar, used in both places it appears.
  const initials = user?.name?.trim().split(/\s+/).map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'A';

  const nameTrimmed = name.trim();
  const nameChanged = nameTrimmed !== (user?.name ?? '');
  const nameValid   = nameTrimmed.length >= 2 && nameTrimmed.length <= 100;

  const joinedDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const tabs = [
    { key: 'profile' as const,  label: 'Profile',  icon: 'fa-user' },
    // Offered only when there is a password to change: a Google account was
    // shown this tab, let the admin fill three fields, then refused.
    ...(googleAccount ? [] : [{ key: 'password' as const, label: 'Change Password', icon: 'fa-lock' }]),
  ];

  const handleSubmit = async () => {
    setSuccessMsg(''); setErrorMsg('');

    if (activeTab === 'password') {
      if (googleAccount)           return setErrorMsg('This account signs in with Google, so it has no password to change.');
      if (!currentPassword.trim()) return setErrorMsg('Please enter your current password.');
      if (!newPassword.trim())     return setErrorMsg('Please enter a new password.');
      if (pwdReused)               return setErrorMsg('The new password must be different from your current one.');
      if (!allRulesMet)            return setErrorMsg('Your new password does not meet all the requirements.');
      if (!confirmPassword.trim()) return setErrorMsg('Please confirm your new password.');
      if (!pwdMatch)               return setErrorMsg('The two new passwords do not match.');
    }

    // Nothing to send is not a success. This used to post an empty name,
    // watch the server ignore it, and report "Profile updated".
    if (activeTab === 'profile') {
      if (!nameValid)   return setErrorMsg('Your name must be between 2 and 100 characters.');
      if (!nameChanged) return setErrorMsg('Nothing to save: your name has not changed.');
    }

    try {
      const { data } = await updateProfile({
        variables: {
          name:            activeTab === 'profile'  ? nameTrimmed    : undefined,
          currentPassword: activeTab === 'password' ? currentPassword : undefined,
          newPassword:     activeTab === 'password' ? newPassword     : undefined,
        },
      });
      if (data?.updateAdminProfile) setUser({ ...user!, name: data.updateAdminProfile.name });
      setSuccessMsg(activeTab === 'password'
        ? 'Password changed. Every other device has been signed out, and we have emailed you about it.'
        : 'Your name has been updated.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'That could not be saved.';
      setErrorMsg(msg === 'Current password is incorrect' ? 'That is not your current password.' : msg);
    }
  };

  const saveDisabled =
    loading ||
    (activeTab === 'profile'  && (!nameValid || !nameChanged)) ||
    (activeTab === 'password' && (!currentPassword || !allRulesMet || !pwdMatch || pwdReused));

  return (
    <div className="min-h-screen -m-7">

      {/* The banner, in the page surface rather than the sidebar's navy. */}
      <div className="bg-[var(--surface)] border-b border-[var(--border)]">
        <div className="max-w-3xl mx-auto px-6 pt-10 pb-8 flex items-center gap-6">
          <div className="w-24 h-24 rounded-card bg-[var(--accent)] flex items-center justify-center text-white text-display font-semibold shrink-0">
            {initials}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-h1 font-semibold text-[var(--text)] truncate">{user?.name}</h1>
              <span className="text-caption font-semibold px-2.5 py-0.5 rounded-control bg-[var(--accent-soft)] text-[var(--accent)]">
                Admin
              </span>
            </div>
            <p className="text-label text-[var(--muted)] mt-0.5 truncate">{user?.email}</p>
            {joinedDate && (
              <p className="text-caption text-[var(--muted2)] mt-2">Member since {joinedDate}</p>
            )}
          </div>
        </div>
      </div>

      {/* The same tabs the student profile uses: separate buttons, the
          current one underlined. They sit below the banner rather than
          floating over its edge in a box of their own. */}
      <div className="max-w-3xl mx-auto px-6">
        {tabs.length > 1 && (
          <div className="flex gap-7 border-b border-[var(--border)] mt-8">
            {tabs.map(t => {
              const active = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setActiveTab(t.key); setSuccessMsg(''); setErrorMsg(''); }}
                  className={cn(
                    'relative flex items-center gap-2 pb-3 text-label font-semibold transition-colors',
                    active
                      ? 'text-[var(--text)] after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[2px] after:bg-[var(--accent)]'
                      : 'text-[var(--muted)] hover:text-[var(--text)]'
                  )}
                >
                  <i className={cn('fas', t.icon, 'text-[12px]')} aria-hidden="true" />
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-5">

        {(successMsg || errorMsg) && (
          <AdminNotice
            kind={successMsg ? 'success' : 'error'}
            message={successMsg || errorMsg}
            onDismiss={() => { setSuccessMsg(''); setErrorMsg(''); }}
          />
        )}

        {activeTab === 'profile' && (
          <>
            <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--border)]">
                <span className="text-label font-semibold text-[var(--text)]">Personal Information</span>
              </div>
              <div className="p-6 flex flex-col gap-5">
                <div>
                  <label htmlFor="admin-name" className="block text-caption font-semibold text-[var(--muted)] mb-1.5">
                    Display Name
                  </label>
                  <input
                    id="admin-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className={FIELD}
                    placeholder="Your name"
                    maxLength={100}
                  />
                  <p className="text-caption text-[var(--muted2)] mt-1.5">
                    Shown on invitations you send and beside anything you change.
                  </p>
                </div>

                <div>
                  <label htmlFor="admin-email" className="block text-caption font-semibold text-[var(--muted)] mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <input id="admin-email" value={user?.email ?? ''} disabled className={cn(FIELD, 'opacity-60 cursor-not-allowed pr-10')} />
                    <i className="fas fa-lock absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-caption" aria-hidden="true" />
                  </div>
                  <p className="text-caption text-[var(--muted2)] mt-1.5">
                    This identifies your account and cannot be changed here.
                  </p>
                </div>

                {googleAccount && (
                  <p className="text-caption text-[var(--muted)]">
                    This account signs in with Google, so there is no password to change here. Manage it in your
                    Google account.
                  </p>
                )}
              </div>
            </div>

            <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--border)]">
                <span className="text-label font-semibold text-[var(--text)]">Account Details</span>
              </div>
              {/* Role, Member since and Sign-in method are read from the
                  account. "Access Level: Full Access" and "Status: Active"
                  sat here too, and neither was looked up: both were strings
                  typed into the page, true by coincidence.

                  Each is a label and a value, the way the student profile
                  writes them. A bordered box around a two-word fact is
                  heavier than the fact. */}
              <dl className="p-6 grid sm:grid-cols-2 gap-x-6 gap-y-5">
                {[
                  { label: 'Role',           value: 'Administrator',     icon: 'fa-user-shield',   brand: false },
                  { label: 'Member since',   value: joinedDate ?? '—',   icon: 'fa-calendar-days', brand: false },
                  { label: 'Sign-in method', value: googleAccount ? 'Google account' : 'Email and password',
                                             icon: googleAccount ? 'fa-google' : 'fa-key', brand: googleAccount },
                ].map(item => (
                  <div key={item.label} className="min-w-0">
                    <dt className={`flex items-center gap-2 ${fieldLabel}`}>
                      <i className={cn(item.brand ? 'fab' : 'fas', item.icon, 'text-[11px] w-3.5 text-center text-[var(--muted2)]')} aria-hidden="true" />
                      {item.label}
                    </dt>
                    <dd className="text-label font-medium text-[var(--text)] mt-1 pl-[22px]">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}

        {activeTab === 'password' && (
          <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--border)]">
              <span className="text-label font-semibold text-[var(--text)]">Change Password</span>
            </div>
            <div className="p-6 flex flex-col gap-5">

              <div>
                <label className="block text-caption font-semibold text-[var(--muted)] mb-1.5">Current Password</label>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    className={cn(FIELD, 'pr-11')}
                    placeholder="Enter your current password"
                  />
                  <button type="button" onClick={() => setShowCurrent(v => !v)} aria-label={showCurrent ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] transition-colors">
                    <i className={cn('fas text-caption', showCurrent ? 'fa-eye-slash' : 'fa-eye')} aria-hidden="true" />
                  </button>
                </div>
                <p className="text-caption text-[var(--muted2)] mt-1.5">
                  Proves the account is yours before the password changes.
                </p>
              </div>

              <div>
                <label className="block text-caption font-semibold text-[var(--muted)] mb-1.5">New Password</label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    className={cn(FIELD, 'pr-11',
                      newPassword && !allRulesMet && 'border-[var(--gold)] focus:border-[var(--gold)]',
                      newPassword && allRulesMet  && 'border-[var(--accent)] focus:border-[var(--accent)]')}
                    placeholder="Choose a new password"
                  />
                  <button type="button" onClick={() => setShowNew(v => !v)} aria-label={showNew ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] transition-colors">
                    <i className={cn('fas text-caption', showNew ? 'fa-eye-slash' : 'fa-eye')} aria-hidden="true" />
                  </button>
                </div>

                {/* The checklist, and nothing above it. A strength meter sat
                    here counting these same four rules and calling four out of
                    four "Strong" — a judgement about guessability it never
                    made. */}
                <ul className="mt-2.5 grid grid-cols-2 gap-y-1 gap-x-4">
                  {pwdRules.map(rule => (
                    <li key={rule.label} className={cn('flex items-center gap-1.5 text-[11px] transition-colors',
                      rule.met ? 'text-[var(--accent)]' : 'text-[var(--muted2)]')}>
                      <i className={cn('fas text-[9px] w-3 text-center', rule.met ? 'fa-check' : 'fa-circle text-[5px]')} aria-hidden="true" />
                      {rule.label}
                    </li>
                  ))}
                </ul>

                {pwdReused && (
                  <p className="text-caption text-[var(--gold)] mt-2">
                    This is your current password. Choose a different one.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-caption font-semibold text-[var(--muted)] mb-1.5">Confirm New Password</label>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    className={cn(FIELD, 'pr-11',
                      confirmPassword && !pwdMatch && 'border-[var(--gold)] focus:border-[var(--gold)]',
                      confirmPassword && pwdMatch  && 'border-[var(--accent)] focus:border-[var(--accent)]')}
                    placeholder="Type the new password again"
                  />
                  <button type="button" onClick={() => setShowConfirm(v => !v)} aria-label={showConfirm ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] transition-colors">
                    <i className={cn('fas text-caption', showConfirm ? 'fa-eye-slash' : 'fa-eye')} aria-hidden="true" />
                  </button>
                </div>
                {confirmPassword !== '' && (
                  <p className={cn('text-caption mt-1.5', pwdMatch ? 'text-[var(--accent)]' : 'text-[var(--gold)]')}>
                    {pwdMatch ? 'The passwords match.' : 'The two passwords do not match.'}
                  </p>
                )}
              </div>

              {/* Said before the button is pressed, not after. */}
              <p className="text-caption text-[var(--muted)] border-t border-[var(--border)] pt-4">
                Changing your password signs you out on every other device and sends you an email saying so. This
                device stays signed in.
              </p>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={saveDisabled}
          className="self-start h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
        >
          {loading ? 'Saving…' : activeTab === 'password' ? 'Change Password' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
