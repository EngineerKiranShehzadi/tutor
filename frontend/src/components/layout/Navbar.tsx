'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';
import { NotificationBell } from '@/components/layout/NotificationBell';

// `section` lists every URL that belongs under this nav item, so the item stays
// marked while the student is anywhere inside it. A lecture lives at
// /lecture/4, not /courses/4, so matching on href alone left nothing underlined
// the moment a lecture was opened — the header then gave no clue where you were.
const NAV_LINKS = [
  { href: '/courses', label: 'Courses', icon: 'fas fa-layer-group', section: ['/courses'] },
  {
    href: '/lectures',
    label: 'Lectures',
    icon: 'fas fa-circle-play',
    section: ['/lectures', '/lecture'],
  },
  {
    href: '/practice',
    label: 'Practice',
    icon: 'fas fa-list-check',
    section: ['/practice'],
  },
  {
    href: '/profile/activity',
    label: 'My Activity',
    icon: 'fas fa-clock-rotate-left',
    section: ['/profile/activity'],
  },
];

/** True when the current URL is the path itself or anything beneath it. */
const isUnder = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

export const Navbar = () => {
  const { user, logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  const [dropdownOpen,  setDropdownOpen]  = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { setDropdownOpen(false); }, [pathname]);

  return (
    <nav
      className="sticky top-0 z-50 flex items-center px-8 h-[72px] gap-4 bg-[var(--accent)]"
      style={{ backdropFilter: 'blur(12px)' }}
    >
      {/* Logo */}
      <Link href="/courses" className="flex items-center shrink-0">
        <Logo variant="dark" className="h-11 w-auto" />
      </Link>

      {/* Nav links */}
      <div className="flex items-center gap-6 ml-6">
        {NAV_LINKS.map(({ href, label, icon, section }) => {
          const active = section.some(path => isUnder(pathname, path));
          return (
            <Link key={href} href={href}
              className={cn(
                // With two destinations the current one is worth marking: a
                // quiet underline, not a filled panel, because a nav item is
                // not a button and should not look pressable.
                'relative flex items-center gap-2 py-2 text-label font-semibold transition-colors',
                active
                  ? 'text-white after:absolute after:left-0 after:right-0 after:-bottom-1 after:h-[2px] after:rounded-full after:bg-white'
                  : 'text-white/65 hover:text-white'
              )}>
              <i className={cn(icon, 'text-[12px]')} />
              {label}
            </Link>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: bell + profile dropdown */}
      {/* gap-4: gap-6 matched the nav links, but those are text labels while
          these are two round controls, and the same number left a visible hole
          between them. */}
      <div className="flex items-center gap-4">

        <NotificationBell />

        {/* Profile dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(v => !v)}
            className={cn(
              // The avatar alone, as Gmail and Slack do it. A pill drawn around
              // the avatar and a caret made an odd two-blob shape; the open and
              // hover states are a ring on the circle itself instead.
              'rounded-full transition-shadow',
              dropdownOpen
                ? 'ring-2 ring-white/60'
                : 'hover:ring-2 hover:ring-white/30'
            )}
          >
            {/* Avatar */}
            {user?.avatar_url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={user.avatar_url}
                alt={user.name}
                className="w-9 h-9 rounded-full object-cover shrink-0"
              />
            ) : (
              // Near-white circle, deep navy initials: the highest contrast
              // pair we own, so it reads as a deliberate mark rather than a
              // translucent grey patch that failed to load. The hairline keeps
              // its edge from merging with the dark bar.
              // The circle is filled with the same white the nav links use when
              // they are not the current page, and the initials are cut out of
              // it in the bar's own colour.
              <div className="w-9 h-9 rounded-full bg-white/65 flex items-center justify-center text-[var(--ink-soft)] text-caption font-semibold tracking-[0.02em] shrink-0">
                {initials}
              </div>
            )}
            {/* The name and a hardcoded "Student" line used to sit here. The
                role was wrong for an admin, and both are shown on the profile
                page anyway. The avatar carries the person's initials, and the
                dropdown names them in full. */}
          </button>

          {/* Dropdown panel */}
          {dropdownOpen && (
            <div
              className="absolute right-0 top-[calc(100%+6px)] w-56 rounded-card border border-[var(--border)] shadow-lg z-50 overflow-hidden"
              style={{ background: '#ffffff' }}
            >
              {/* User info header */}
              <div className="px-4 py-3 border-b border-[var(--border)]" style={{ background: 'var(--surface)' }}>
                <div className="flex items-center gap-2.5">
                  {user?.avatar_url ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={user.avatar_url} alt={user?.name} className="w-9 h-9 rounded-card object-cover shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-card bg-[var(--accent)] flex items-center justify-center text-white text-[13px] font-bold shrink-0">
                      {initials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text)] truncate">{user?.name}</p>
                    <p className="text-[11px] text-[var(--muted2)] truncate">{user?.email}</p>
                  </div>
                </div>
              </div>

              {/* Menu items */}
              <div className="py-1.5">
                <Link
                  href="/profile"
                  className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors"
                >
                  <div className="w-7 h-7 rounded-control bg-white/10 flex items-center justify-center shrink-0">
                    <i className="fas fa-user text-[var(--muted)] text-[11px]" />
                  </div>
                  My profile
                </Link>
              </div>

              {/* Divider + logout */}
              <div className="border-t border-[var(--border)] py-1.5">
                <button
                  onClick={() => { setDropdownOpen(false); logout(); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                >
                  <div className="w-7 h-7 rounded-control bg-red-500/10 flex items-center justify-center shrink-0">
                    <i className="fas fa-right-from-bracket text-red-400 text-[11px]" />
                  </div>
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
};
