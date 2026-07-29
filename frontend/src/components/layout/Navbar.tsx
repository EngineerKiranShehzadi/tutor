'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
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

  const [dropdownOpen,  setDropdownOpen]  = useState(false);
  const [bellOpen,      setBellOpen]      = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const bellRef     = useRef<HTMLDivElement>(null);

  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { setDropdownOpen(false); setBellOpen(false); }, [pathname]);

  return (
    <nav
      className="sticky top-0 z-50 border-b border-white/10 flex items-center px-8 h-[80px] gap-4 bg-gradient-to-r from-slate-800 via-slate-700 to-indigo-800"
      style={{ backdropFilter: 'blur(12px)' }}
    >
      {/* Logo */}
      <Link href="/courses" className="flex items-center shrink-0">
        <Logo variant="dark" className="h-12 w-auto" />
      </Link>

      {/* Nav links */}
      <div className="flex items-center gap-1 ml-4">
        {NAV_LINKS.map(({ href, label, icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link key={href} href={href}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-[18px] font-semibold transition-colors',
                active
                  ? 'bg-white/10 text-white'
                  : 'text-slate-300 hover:bg-white/8 hover:text-white'
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
      <div className="flex items-center gap-2">

        {/* Notification bell */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => { setBellOpen(v => !v); setDropdownOpen(false); }}
            className="relative w-11 h-11 rounded-xl flex items-center justify-center hover:bg-white/10 transition-colors text-slate-300 hover:text-white border border-white/10"
          >
            <i className="fas fa-bell text-[18px]" />
          </button>

          {bellOpen && (
            <div
              className="absolute right-0 top-[calc(100%+8px)] w-72 rounded-2xl border border-white/10 shadow-2xl z-50 overflow-hidden"
              style={{ background: 'linear-gradient(135deg,#1e293b,#312e81)', backdropFilter: 'blur(16px)' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <span className="text-[14px] font-semibold text-white">Notifications</span>
                <span className="text-[11px] text-slate-400">0 new</span>
              </div>
              <div className="flex flex-col items-center justify-center py-10 gap-3">
                <div className="w-12 h-12 rounded-2xl bg-white/8 flex items-center justify-center">
                  <i className="fas fa-bell-slash text-slate-400 text-[20px]" />
                </div>
                <p className="text-[13px] text-slate-400">No recent notifications</p>
              </div>
            </div>
          )}
        </div>

        {/* Profile dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(v => !v)}
            className={cn(
              'flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl border transition-colors',
              dropdownOpen
                ? 'bg-white/10 border-white/20'
                : 'border-white/10 hover:bg-white/8 hover:border-white/20'
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
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-[12px] font-bold shrink-0">
                {initials}
              </div>
            )}
            <div className="text-left hidden sm:block">
              <p className="text-[14px] font-semibold text-white leading-none">{user?.name}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Student</p>
            </div>
            <i className={cn(
              'fas fa-chevron-down text-[9px] text-slate-400 ml-0.5 transition-transform',
              dropdownOpen && 'rotate-180'
            )} />
          </button>

          {/* Dropdown panel */}
          {dropdownOpen && (
            <div
              className="absolute right-0 top-[calc(100%+6px)] w-56 rounded-2xl border border-white/10 shadow-2xl z-50 overflow-hidden"
              style={{ background: 'linear-gradient(135deg,#1e293b,#312e81)', backdropFilter: 'blur(16px)' }}
            >
              {/* User info header */}
              <div className="px-4 py-3 border-b border-white/10" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div className="flex items-center gap-2.5">
                  {user?.avatar_url ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={user.avatar_url} alt={user?.name} className="w-9 h-9 rounded-xl object-cover shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-[13px] font-bold shrink-0">
                      {initials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-white truncate">{user?.name}</p>
                    <p className="text-[11px] text-slate-400 truncate">{user?.email}</p>
                  </div>
                </div>
              </div>

              {/* Menu items */}
              <div className="py-1.5">
                <Link
                  href="/profile"
                  className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-slate-300 hover:bg-white/8 hover:text-white transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
                    <i className="fas fa-user text-slate-300 text-[11px]" />
                  </div>
                  Dashboard
                </Link>
              </div>

              {/* Divider + logout */}
              <div className="border-t border-white/10 py-1.5">
                <button
                  onClick={() => { setDropdownOpen(false); logout(); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
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
