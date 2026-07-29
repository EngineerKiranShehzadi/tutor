'use client';
import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/courses',          icon: 'fas fa-graduation-cap', label: 'Courses'     },
  { href: '/profile',          icon: 'fas fa-user-circle',    label: 'My Profile'  },
  { href: '/profile/activity', icon: 'fas fa-chart-line',     label: 'My Activity' },
];

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const initials = user?.name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  return (
    <div className="min-h-screen flex bg-slate-50">

      {/* ── Sidebar ── */}
      <aside className="w-[240px] shrink-0 bg-slate-950 flex flex-col h-screen sticky top-0">

        {/* Brand */}
        <div className="px-5 pt-6 pb-5 border-b border-slate-800">
          <Link href="/courses" className="flex flex-col gap-1">
            <Logo variant="dark" className="h-9 w-auto" />
            <p className="text-[13px] text-slate-500">Student Portal</p>
          </Link>
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <p className="px-2 mb-2 text-[11px] font-semibold text-slate-600 uppercase tracking-widest">Navigation</p>
          {NAV.map(({ href, icon, label }) => {
            const active = pathname === href;
            return (
              <Link key={href} href={href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-[16px] font-semibold transition-all mb-0.5',
                  active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                )}
              >
                <i className={cn(icon, 'w-5 text-center text-[15px]', active ? 'text-white' : 'text-slate-500')} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* User menu */}
        <div className="px-3 pb-4 relative">
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute bottom-[calc(100%+6px)] left-3 right-3 z-30 bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3.5 bg-slate-50 border-b border-slate-100">
                  <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                    {user?.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold">
                        {initials}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-slate-800 truncate">{user?.name}</p>
                    <p className="text-[12px] text-slate-400 truncate">{user?.email}</p>
                  </div>
                </div>
                <div className="border-t border-slate-100 py-1.5">
                  <button
                    onClick={() => { setUserMenuOpen(false); logout(); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                      <i className="fas fa-right-from-bracket text-red-500 text-[11px]" />
                    </div>
                    Sign Out
                  </button>
                </div>
              </div>
            </>
          )}

          <button
            onClick={() => setUserMenuOpen(v => !v)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all text-left',
              userMenuOpen ? 'bg-slate-800 border-indigo-500/50' : 'bg-slate-900 border-slate-800 hover:bg-slate-800 hover:border-slate-700'
            )}
          >
            <div className="w-8 h-8 rounded-full overflow-hidden shrink-0">
              {user?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt={user?.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[13px] font-bold">
                  {initials}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold text-slate-200 truncate">{user?.name}</p>
              <p className="text-[12px] text-slate-500 truncate">Student</p>
            </div>
            <i className={cn('fas fa-chevron-up text-[10px] text-slate-500 transition-transform shrink-0', !userMenuOpen && 'rotate-180')} />
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
