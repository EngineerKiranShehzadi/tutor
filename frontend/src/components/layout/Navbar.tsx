'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';

const NAV_LINKS = [
  { href: '/courses',  label: 'Courses', icon: 'fas fa-graduation-cap' },
];

export const Navbar = () => {
  const { user, logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close dropdown on route change
  useEffect(() => { setDropdownOpen(false); }, [pathname]);

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-slate-200 flex items-center px-6 h-14 gap-4 shadow-sm">

      {/* Logo */}
      <Link href="/courses" className="flex items-center shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="AskAI Tutor" className="h-12 w-auto object-contain" />
      </Link>

      {/* Nav links */}
      <div className="flex items-center gap-1 ml-4">
        {NAV_LINKS.map(({ href, label, icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link key={href} href={href}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-[15px] font-bold transition-colors',
                active
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              )}>
              <i className={cn(icon, 'text-[13px]')} />
              {label}
            </Link>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: bell + profile dropdown */}
      <div className="flex items-center gap-2">

        {/* Notification bell */}
        <button className="relative w-9 h-9 rounded-xl flex items-center justify-center bg-indigo-50 hover:bg-indigo-100 transition-colors text-indigo-500 border border-indigo-100">
          <i className="fas fa-bell text-[14px]" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-500 rounded-full border-2 border-white" />
        </button>

        {/* Profile dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(v => !v)}
            className={cn(
              'flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl border transition-colors',
              dropdownOpen
                ? 'bg-indigo-50 border-indigo-200'
                : 'border-slate-200 hover:bg-slate-50'
            )}
          >
            {/* Avatar */}
            {user?.avatar_url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={user.avatar_url}
                alt={user.name}
                className="w-8 h-8 rounded-lg object-cover shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-[12px] font-bold shrink-0">
                {initials}
              </div>
            )}
            <div className="text-left hidden sm:block">
              <p className="text-[13px] font-semibold text-slate-800 leading-none">{user?.name}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Student</p>
            </div>
            <i className={cn(
              'fas fa-chevron-down text-[9px] text-slate-400 ml-0.5 transition-transform',
              dropdownOpen && 'rotate-180'
            )} />
          </button>

          {/* Dropdown panel */}
          {dropdownOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] w-56 bg-white rounded-2xl border border-slate-200 shadow-xl z-50 overflow-hidden">
              {/* User info header */}
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  {user?.avatar_url ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={user.avatar_url} alt={user?.name} className="w-9 h-9 rounded-xl object-cover shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white text-[13px] font-bold shrink-0">
                      {initials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{user?.name}</p>
                    <p className="text-[12px] text-slate-400 truncate">{user?.email}</p>
                  </div>
                </div>
              </div>

              {/* Menu items */}
              <div className="py-1.5">
                <Link
                  href="/profile"
                  className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                    <i className="fas fa-user text-indigo-500 text-[11px]" />
                  </div>
                  My Profile
                </Link>
              </div>

              {/* Divider + logout */}
              <div className="border-t border-slate-100 py-1.5">
                <button
                  onClick={() => { setDropdownOpen(false); logout(); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-600 hover:bg-red-50 transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                    <i className="fas fa-right-from-bracket text-red-500 text-[11px]" />
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
