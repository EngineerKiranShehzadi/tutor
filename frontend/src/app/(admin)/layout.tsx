'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/admin/dashboard',  icon: 'fas fa-chart-pie',       label: 'Overview'   },
  { href: '/admin/lectures',   icon: 'fas fa-play-circle',     label: 'Lectures'   },
  { href: '/admin/students',   icon: 'fas fa-user-graduate',   label: 'Students'   },
  { href: '/admin/questions',  icon: 'fas fa-comments',        label: 'Questions'  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'ADMIN') router.replace('/courses');
  }, [user, isLoading, router]);

  if (isLoading || !user || user.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-slate-400">Loading…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside className="w-[220px] shrink-0 bg-slate-950 flex flex-col h-screen sticky top-0">
        {/* Brand */}
        <div className="px-5 pt-6 pb-5 border-b border-slate-800">
          <Link href="/admin/dashboard" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 group-hover:bg-indigo-500 transition-colors">
              <i className="fas fa-robot text-white text-[12px]" />
            </div>
            <div>
              <p className="text-[14px] font-bold text-white leading-none">
                AskAI<span className="text-indigo-400">Tutor</span>
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5">Admin Console</p>
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          <p className="px-2 mb-2 text-[10px] font-semibold text-slate-600 uppercase tracking-widest">Menu</p>
          {NAV.map(({ href, icon, label }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all',
                  active
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                )}
              >
                <i className={cn(icon, 'w-[15px] text-center text-[12px]', active ? 'text-white' : 'text-slate-500')} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* System status */}
        <div className="px-4 py-3 mx-3 mb-3 bg-slate-900 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-semibold text-slate-300">System Online</span>
          </div>
          <p className="text-[10px] text-slate-500">All services operational</p>
        </div>

        {/* User */}
        <div className="px-3 pb-4">
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-slate-900 border border-slate-800">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
              {user.name?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-slate-200 truncate">{user.name}</p>
              <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="text-slate-600 hover:text-red-400 transition-colors ml-1"
            >
              <i className="fas fa-right-from-bracket text-[12px]" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center px-6 shrink-0 sticky top-0 z-10">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-slate-400">Admin</span>
            <i className="fas fa-chevron-right text-[9px] text-slate-300" />
            <span className="font-semibold text-slate-700 capitalize">
              {pathname.split('/').filter(Boolean).pop()?.replace('-', ' ') ?? 'Dashboard'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full font-medium">
              <i className="fas fa-shield-halved mr-1 text-indigo-500" />
              Admin
            </span>
          </div>
        </header>

        <main className="flex-1 p-7 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
