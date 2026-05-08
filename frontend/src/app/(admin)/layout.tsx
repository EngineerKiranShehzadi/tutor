'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@apollo/client';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';
import { GET_LECTURE_AGENT_DETAILS } from '@/graphql/admin.queries';

const NAV = [
  { href: '/admin/dashboard',     icon: 'fas fa-chart-pie',       label: 'Overview'           },
  { href: '/admin/lectures',      icon: 'fas fa-play-circle',     label: 'Lectures'           },
  { href: '/admin/students',      icon: 'fas fa-user-graduate',   label: 'Students'           },
  { href: '/admin/questions',     icon: 'fas fa-comments',        label: 'Questions'          },
  { href: '/admin/content-gaps',  icon: 'fas fa-magnifying-glass-chart', label: 'Content Gaps' },
  { href: '/admin/users',         icon: 'fas fa-users-gear',      label: 'User Mgmt'          },
  { href: '/admin/agents',        icon: 'fas fa-robot',           label: 'AI Agents'          },
  { href: '/admin/settings',      icon: 'fas fa-user-shield',     label: 'Admin Profile'      },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();
  const [notifOpen,   setNotifOpen]   = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const { data: agentData } = useQuery(GET_LECTURE_AGENT_DETAILS, {
    fetchPolicy: 'network-only',
    skip: isLoading || !user,
  });
  const failedAgents = (agentData?.lectureAgentDetails ?? []).filter((a: { status: string }) => a.status === 'FAILED');
  const notifCount = failedAgents.length;

  useEffect(() => {
    if (isLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'ADMIN') router.replace('/courses');
  }, [user, isLoading, router]);

  // Close menus on route change
  useEffect(() => { setNotifOpen(false); setUserMenuOpen(false); }, [pathname]);

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
      <aside className="w-[240px] shrink-0 bg-slate-950 flex flex-col h-screen sticky top-0">
        {/* Brand */}
        <div className="px-5 pt-6 pb-5 border-b border-slate-800">
          <Link href="/admin/dashboard" className="flex flex-col gap-1 group">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="AskAI Tutor" className="w-full object-contain" />
            <p className="text-[13px] text-slate-500">Admin Console</p>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <p className="px-2 mb-2 text-[12px] font-semibold text-slate-600 uppercase tracking-widest">Analytics</p>
          {NAV.slice(0, 5).map(({ href, icon, label }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} href={href}
                className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg text-[17px] font-medium transition-all mb-0.5',
                  active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                )}>
                <i className={cn(icon, 'w-[18px] text-center text-[16px]', active ? 'text-white' : 'text-slate-500')} />
                {label}
              </Link>
            );
          })}
          <p className="px-2 mt-4 mb-2 text-[12px] font-semibold text-slate-600 uppercase tracking-widest">Management</p>
          {NAV.slice(5).map(({ href, icon, label }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} href={href}
                className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg text-[17px] font-medium transition-all mb-0.5',
                  active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                )}>
                <i className={cn(icon, 'w-[18px] text-center text-[16px]', active ? 'text-white' : 'text-slate-500')} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* System status */}
        <div className="px-4 py-3 mx-3 mb-3 bg-slate-900 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[15px] font-semibold text-slate-300">System Online</span>
          </div>
          <p className="text-[12px] text-slate-500">All services operational</p>
        </div>

        {/* User menu trigger */}
        <div className="px-3 pb-4 relative">
          {/* Floating dropdown — opens upward above the card */}
          {userMenuOpen && (
            <>
              {/* Backdrop to close on outside click */}
              <div className="fixed inset-0 z-20" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute bottom-[calc(100%+6px)] left-3 right-3 z-30 bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
                {/* User identity header */}
                <div className="flex items-center gap-3 px-4 py-3.5 bg-slate-50 border-b border-slate-100">
                  <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0">
                    {user.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[15px] font-bold">
                        {user.name?.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold text-slate-800 truncate">{user.name}</p>
                    <p className="text-[12px] text-slate-400 truncate">{user.email}</p>
                  </div>
                </div>

                {/* Menu items */}
                <div className="py-1.5">
                  <Link
                    href="/admin/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                      <i className="fas fa-user text-indigo-500 text-[11px]" />
                    </div>
                    Profile &amp; Settings
                  </Link>
                </div>

                {/* Divider + logout */}
                <div className="border-t border-slate-100 py-1.5">
                  <button
                    onClick={() => { setUserMenuOpen(false); logout(); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                      <i className="fas fa-right-from-bracket text-red-500 text-[11px]" />
                    </div>
                    Log out
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Clickable user card */}
          <button
            onClick={() => setUserMenuOpen(v => !v)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all text-left',
              userMenuOpen
                ? 'bg-slate-800 border-indigo-500/50'
                : 'bg-slate-900 border-slate-800 hover:bg-slate-800 hover:border-slate-700'
            )}
          >
            <div className="w-8 h-8 rounded-full overflow-hidden shrink-0">
              {user.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-[13px] font-bold">
                  {user.name?.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold text-slate-200 truncate">{user.name}</p>
              <p className="text-[11px] text-slate-500 truncate">Admin</p>
            </div>
            <i className={cn(
              'fas fa-chevron-up text-[10px] text-slate-500 transition-transform shrink-0',
              !userMenuOpen && 'rotate-180'
            )} />
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center px-6 shrink-0 sticky top-0 z-10">
          <div className="flex items-center gap-2 text-[14px]">
            <span className="text-slate-400">Admin</span>
            <i className="fas fa-chevron-right text-[10px] text-slate-300" />
            <span className="font-semibold text-slate-700 capitalize">
              {pathname.split('/').filter(Boolean).pop()?.replace('-', ' ') ?? 'Dashboard'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* Notification bell */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen(o => !o)}
                className="relative w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
              >
                <i className="fas fa-bell text-slate-500 text-[14px]" />
                {notifCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {notifCount}
                  </span>
                )}
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-11 w-72 bg-white rounded-2xl border border-slate-200 shadow-xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-[13px] font-bold text-slate-800">Notifications</span>
                    <button onClick={() => setNotifOpen(false)} className="text-slate-400 hover:text-slate-600 text-[12px]"><i className="fas fa-xmark" /></button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-50">
                    {notifCount === 0 ? (
                      <div className="px-4 py-6 text-center text-[13px] text-slate-400">
                        <i className="fas fa-check-circle text-emerald-400 text-xl mb-2 block" />
                        All systems operational
                      </div>
                    ) : (
                      failedAgents.map((a: { id: number; title: string }) => (
                        <Link key={a.id} href={`/admin/lectures/${a.id}`} onClick={() => setNotifOpen(false)}
                          className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                          <div className="w-7 h-7 rounded-lg bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
                            <i className="fas fa-circle-exclamation text-red-500 text-[11px]" />
                          </div>
                          <div>
                            <p className="text-[13px] font-semibold text-slate-800">Embedding Failed</p>
                            <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{a.title}</p>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <span className="text-[13px] text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full font-medium">
              <i className="fas fa-shield-halved mr-1 text-indigo-500" />
              Admin
            </span>
          </div>
        </header>

        <main className="flex-1 p-7 overflow-auto [&>div]:mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
