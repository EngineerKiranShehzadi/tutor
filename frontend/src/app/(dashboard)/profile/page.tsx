'use client';
import { useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { authApi } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Profile — account details and password.
 *
 * Rewritten onto the product theme. The previous version used indigo, violet,
 * emerald and slate (98 colour classes, none of them from the theme), four
 * gradients, 2xl/3xl corner radii, drop shadows and uppercase micro-labels, so
 * it was the one student page that looked like a different product.
 *
 * All of the behaviour is unchanged: avatar upload with a 2 MB limit, name with
 * a 100-character limit, read-only email, the four password rules and the
 * strength meter, and the Google-account case where there is no password tab.
 *
 * One fault fixed: pressing Save without changing anything used to report
 * "Profile updated successfully". It now says there is nothing to save.
 */

const FIELD =
  'w-full h-11 px-3.5 bg-white border border-[var(--border)] rounded-control text-body ' +
  'text-[var(--text)] outline-none transition-colors placeholder:text-[var(--muted2)] ' +
  'focus:border-[var(--accent)]';

const RULES = [
  { label: 'At least 8 characters',          test: (p: string) => p.length >= 8          },
  { label: 'At least one uppercase letter',  test: (p: string) => /[A-Z]/.test(p)        },
  { label: 'At least one number',            test: (p: string) => /[0-9]/.test(p)        },
  { label: 'At least one special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

// Weak and fair stay red and amber because they are warnings and must not be
// mistaken for progress. Good and strong use the brand colour rather than a
// second green, so the meter never introduces a colour the theme does not have.
function strengthLabel(score: number): { label: string; bar: string; text: string } {
  if (score <= 1)  return { label: 'Weak',   bar: 'bg-red-500',           text: 'text-red-600' };
  if (score === 2) return { label: 'Fair',   bar: 'bg-amber-500',         text: 'text-amber-600' };
  if (score === 3) return { label: 'Good',   bar: 'bg-[var(--accent-dim)]', text: 'text-[var(--accent)]' };
  return             { label: 'Strong', bar: 'bg-[var(--accent)]',     text: 'text-[var(--accent)]' };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-label font-medium text-[var(--muted)]">{label}</label>
      {children}
      {hint && <p className="text-caption text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--border)] rounded-card">
      <div className="px-6 py-4 border-b border-[var(--border)]">
        <h2 className="text-h3 font-semibold text-[var(--text)]">{title}</h2>
      </div>
      <div className="p-6 flex flex-col gap-5">{children}</div>
    </section>
  );
}

export default function ProfilePage() {
  const { user, setUser } = useAuth();
  const isGoogleUser = !!user?.google_id;

  const [name,            setName]            = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMsg,      setSuccessMsg]      = useState('');
  const [errorMsg,        setErrorMsg]        = useState('');
  const [saving,          setSaving]          = useState(false);
  const [showCurrent,     setShowCurrent]     = useState(false);
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [avatarPreview,   setAvatarPreview]   = useState<string | null>(user?.avatar_url ?? null);
  const [avatarBase64,    setAvatarBase64]    = useState<string | null>(null);
  const [activeTab,       setActiveTab]       = useState<'profile' | 'password'>('profile');

  const fileRef  = useRef<HTMLInputElement>(null);
  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  const passScore      = RULES.filter(r => r.test(newPassword)).length;
  const strength       = strengthLabel(passScore);
  const passwordsMatch = confirmPassword === newPassword;

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
    if (activeTab === 'password') {
      if (!currentPassword) { setErrorMsg('Enter your current password.'); return; }
      if (passScore < 3)    { setErrorMsg('New password is too weak. Follow the rules below.'); return; }
      if (!passwordsMatch)  { setErrorMsg('Passwords do not match.'); return; }
    }

    const payload: Record<string, string> = {};
    if (name.trim() && name.trim() !== user?.name) payload.name = name.trim();
    if (avatarBase64) payload.avatarUrl = avatarBase64;
    if (activeTab === 'password' && newPassword) {
      payload.currentPassword = currentPassword;
      payload.newPassword     = newPassword;
    }

    // Nothing was actually edited. Saying "updated successfully" here was a lie:
    // the request carried no changes and the database was never touched.
    if (Object.keys(payload).length === 0) {
      setErrorMsg('Nothing to save. Change your name, your photo or your password first.');
      return;
    }

    setSaving(true);
    try {
      const res = await authApi.updateProfile(payload);
      const updated = res.data?.data;
      if (updated) setUser({ ...user!, name: updated.name, avatar_url: updated.avatar_url });
      setSuccessMsg('Profile updated.');
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

  // 'STUDENT' -> 'Student'. This used to be the word "Student" written into
  // the markup, which would have shown "Student" to an admin as well.
  const roleLabel = user?.role
    ? user.role.charAt(0) + user.role.slice(1).toLowerCase()
    : '—';

  const tabs = [
    { key: 'profile',  label: 'Profile',  icon: 'fa-user' },
    ...(!isGoogleUser ? [{ key: 'password', label: 'Password', icon: 'fa-lock' }] : []),
  ] as { key: 'profile' | 'password'; label: string; icon: string }[];

  return (
    <div className="max-w-[760px] mx-auto px-6 py-10">

      <h1 className="text-h1 font-semibold text-[var(--text)]">Profile</h1>
      <p className="text-body text-[var(--muted)] mt-2 mb-6">
        Your account details, and the password you sign in with.
      </p>

      {/* Identity. Flat --ink-soft, the same colour as the header, instead of
          the three-stop slate-to-indigo gradient this used to carry. */}
      <div className="bg-[var(--ink-soft)] rounded-card px-6 py-6 flex items-center gap-5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="relative shrink-0 group rounded-card"
          aria-label="Change profile photo"
        >
          {avatarPreview ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={avatarPreview} alt="" className="w-20 h-20 rounded-card object-cover" />
          ) : (
            <div className="w-20 h-20 rounded-card bg-[var(--accent)] flex items-center justify-center text-white text-h2 font-semibold">
              {initials}
            </div>
          )}
          <span className="absolute inset-0 rounded-card flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity">
            <i className="fas fa-camera text-white text-body" />
          </span>
        </button>
        <input
          ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp"
          className="hidden" onChange={handleAvatarChange}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <p className="text-h3 font-semibold text-white truncate">{user?.name}</p>
            <span className="text-caption font-medium px-2 py-0.5 rounded-full bg-white/15 text-white">
              Student
            </span>
            {isGoogleUser && (
              <span className="text-caption font-medium px-2 py-0.5 rounded-full bg-white/15 text-white flex items-center gap-1.5">
                <i className="fab fa-google text-[10px]" /> Google
              </span>
            )}
          </div>
          <p className="text-label mt-1 truncate" style={{ color: '#a7b3ad' }}>{user?.email}</p>
          {joinedDate && (
            <p className="text-caption mt-2" style={{ color: '#7b8781' }}>
              Member since {joinedDate}
            </p>
          )}
        </div>
      </div>

      {/* Tabs. An underline, the same language the header uses for the current
          section — not a filled indigo pill, which read as a pressed button. */}
      {tabs.length > 1 && (
        <div className="flex gap-7 border-b border-[var(--border)] mt-8 mb-6">
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
                <i className={cn('fas', t.icon, 'text-[12px]')} />
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      <form onSubmit={handleSave} className="flex flex-col gap-4">

        {activeTab === 'profile' && (
          <>
            <Card title="Personal information">
              <Field label="Display name" hint={`${name.length}/100 characters`}>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  maxLength={100} minLength={2} required
                  className={FIELD}
                  placeholder="Your full name"
                />
              </Field>

              <Field label="Email address" hint="Your email address cannot be changed.">
                <div className="relative">
                  <input
                    value={user?.email ?? ''}
                    disabled
                    className={cn(FIELD, 'bg-[var(--surface)] text-[var(--muted)] cursor-not-allowed pr-10')}
                  />
                  <i className="fas fa-lock absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-caption" />
                </div>
              </Field>

              <Field label="Profile photo" hint="JPG, PNG or WebP, up to 2 MB.">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="self-start inline-flex items-center gap-2 h-10 px-4 rounded-control border border-[var(--border)] text-label font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface)]"
                >
                  <i className="fas fa-upload text-caption" />
                  Upload a new photo
                </button>
              </Field>
            </Card>

            <Card title="Account details">
              {/* Every row below is read from the signed-in account. A fifth
                  row, "Status: Active", used to sit here with the word written
                  into the code: there is no status field on the user record, so
                  it was the one invented line on this page. It is removed
                  rather than left to be asked about. */}
              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-5">
                {[
                  { label: 'Role',           value: roleLabel,         icon: 'fa-user-graduate', brand: false },
                  { label: 'Member since',   value: joinedDate ?? '—', icon: 'fa-calendar-days', brand: false },
                  { label: 'Sign-in method', value: isGoogleUser ? 'Google account' : 'Email and password',
                                             icon: isGoogleUser ? 'fa-google' : 'fa-key', brand: isGoogleUser },
                ].map(item => (
                  // The icon sits inline with the label at the label's own
                  // size. It was a 32px bordered tile, which made a decorative
                  // box heavier than the fact it was labelling.
                  <div key={item.label} className="min-w-0">
                    <dt className="flex items-center gap-2 text-caption text-[var(--muted)]">
                      <i className={cn(item.brand ? 'fab' : 'fas', item.icon, 'text-[11px] w-3.5 text-center text-[var(--muted2)]')} />
                      {item.label}
                    </dt>
                    <dd className="text-label font-medium text-[var(--text)] mt-1 pl-[22px]">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </>
        )}

        {activeTab === 'password' && !isGoogleUser && (
          <Card title="Change password">
            <Field label="Current password">
              <div className="relative">
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  className={cn(FIELD, 'pr-10')}
                  placeholder="Your current password"
                  required
                />
                <button
                  type="button" onClick={() => setShowCurrent(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] text-caption"
                  aria-label={showCurrent ? 'Hide password' : 'Show password'}
                >
                  <i className={cn('fas', showCurrent ? 'fa-eye-slash' : 'fa-eye')} />
                </button>
              </div>
            </Field>

            <Field label="New password">
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className={cn(FIELD, 'pr-10')}
                  placeholder="At least 8 characters"
                  required
                />
                <button
                  type="button" onClick={() => setShowNew(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] text-caption"
                  aria-label={showNew ? 'Hide password' : 'Show password'}
                >
                  <i className={cn('fas', showNew ? 'fa-eye-slash' : 'fa-eye')} />
                </button>
              </div>
            </Field>

            {newPassword && (
              <div className="-mt-2">
                <div className="flex gap-1.5 mb-2">
                  {[0, 1, 2, 3].map(i => (
                    <div
                      key={i}
                      className={cn(
                        'h-1 flex-1 rounded-full transition-colors',
                        i < passScore ? strength.bar : 'bg-[var(--border)]'
                      )}
                    />
                  ))}
                </div>
                <p className={cn('text-caption font-medium', strength.text)}>
                  Password strength: {strength.label}
                </p>
                <ul className="mt-3 flex flex-col gap-1.5">
                  {RULES.map(r => {
                    const met = r.test(newPassword);
                    return (
                      <li
                        key={r.label}
                        className={cn(
                          'flex items-center gap-2 text-caption',
                          met ? 'text-[var(--text)]' : 'text-[var(--muted)]'
                        )}
                      >
                        <i
                          className={cn(
                            'fas text-[11px]',
                            met ? 'fa-circle-check text-[var(--accent)]' : 'fa-circle text-[var(--muted2)]'
                          )}
                        />
                        {r.label}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <Field label="Confirm new password">
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className={cn(
                    FIELD, 'pr-10',
                    confirmPassword && !passwordsMatch && 'border-red-400 focus:border-red-500',
                    confirmPassword &&  passwordsMatch && 'border-[var(--accent)]'
                  )}
                  placeholder="Repeat the new password"
                  required
                />
                <button
                  type="button" onClick={() => setShowConfirm(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted2)] hover:text-[var(--text)] text-caption"
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                >
                  <i className={cn('fas', showConfirm ? 'fa-eye-slash' : 'fa-eye')} />
                </button>
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-caption text-red-600 flex items-center gap-1.5">
                  <i className="fas fa-circle-exclamation text-[11px]" /> The passwords do not match
                </p>
              )}
              {confirmPassword && passwordsMatch && (
                <p className="text-caption text-[var(--accent)] flex items-center gap-1.5">
                  <i className="fas fa-circle-check text-[11px]" /> The passwords match
                </p>
              )}
            </Field>
          </Card>
        )}

        {successMsg && (
          <div className="flex items-center gap-2.5 bg-[var(--accent-soft)] border border-[var(--border)] rounded-card px-4 py-3 text-label text-[var(--accent-deep)]">
            <i className="fas fa-circle-check text-[var(--accent)] shrink-0" />
            {successMsg}
          </div>
        )}
        {errorMsg && (
          <div className="flex items-center gap-2.5 bg-red-50 border border-red-200 rounded-card px-4 py-3 text-label text-red-700">
            <i className="fas fa-circle-exclamation text-red-600 shrink-0" />
            {errorMsg}
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={saving || (activeTab === 'password' && (!passwordsMatch || passScore < 3))}
            className="inline-flex items-center gap-2 h-11 px-6 rounded-control bg-[var(--accent)] text-white text-label font-semibold transition-colors hover:bg-[var(--accent-deep)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              'Save changes'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
