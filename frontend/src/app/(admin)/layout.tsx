'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/ui/Logo';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';

// "User Mgmt" and "Advanced traces" were the only abbreviated and
// sentence-cased labels in the list; every nav item now reads the same way.
const NAV = [
  { href: '/admin/dashboard',     icon: 'fas fa-table-columns',         label: 'Overview'         },
  { href: '/admin/courses',       icon: 'fas fa-layer-group',           label: 'Courses'          },
  { href: '/admin/lectures',      icon: 'fas fa-play-circle',           label: 'Lectures'         },
  { href: '/admin/students',      icon: 'fas fa-user-graduate',         label: 'Students'         },
  { href: '/admin/questions',     icon: 'fas fa-comments',              label: 'Questions'        },
  { href: '/admin/content-gaps',  icon: 'fas fa-magnifying-glass-chart', label: 'Content Gaps'    },
  { href: '/admin/learning-outcomes',icon: 'fas fa-bullseye', label: 'Learning Outcomes' },
  { href: '/admin/faculty-gaps', icon: 'fas fa-chart-column', label: 'Learning Gaps' },
  { href: '/admin/rag-evaluation', icon: 'fas fa-flask', label: 'RAG Evaluation' },
  { href: '/admin/users',         icon: 'fas fa-users-gear',            label: 'User Management'  },
  { href: '/admin/agents',        icon: 'fas fa-robot',                 label: 'AI Agents'        },
  { href: '/admin/monitor',       icon: 'fas fa-heart-pulse',           label: 'Tutor Monitor'    },
  { href: '/admin/rag-traces',    icon: 'fas fa-timeline',              label: 'Advanced Traces'  },
  { href: '/admin/settings',      icon: 'fas fa-user-shield',           label: 'Admin Profile'    },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'ADMIN') router.replace('/courses');
  }, [user, isLoading, router]);

  // Close menus on route change
  useEffect(() => { setUserMenuOpen(false); }, [pathname]);

  if (isLoading || !user || user.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <span className="text-label text-[var(--muted)]">Loading…</span>
        </div>
      </div>
    );
  }

  const navLink = (href: string, icon: string, label: string) => {
    const active = pathname === href || pathname.startsWith(href + '/');
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-control text-caption transition-colors',
          active
            ? 'bg-white/12 text-white font-semibold'
            : 'text-white/70 font-medium hover:bg-white/8 hover:text-white'
        )}
      >
        <i className={cn(icon, 'w-[16px] text-center text-[13px]', active ? 'text-white' : 'text-white/55')} aria-hidden="true" />
        {label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen flex bg-[var(--bg)]">
      {/* The sidebar is the admin's version of the student header, so it is the
          same accent surface rather than a near-black slate, and the active
          item is lifted with white rather than a second, different blue. */}
      <aside className="w-[260px] shrink-0 bg-[var(--accent)] flex flex-col h-screen sticky top-0">
        <div className="px-6 pt-5 pb-3.5">
          <Link href="/admin/dashboard" className="flex flex-col gap-2">
            <Logo variant="dark" className="h-10 w-auto -ml-3" />
            <p className="text-caption text-white/55">Admin Console</p>
          </Link>
        </div>

        <nav className="sidebar-scroll flex-1 px-3 pt-1 pb-4 overflow-y-auto">
          <p className="px-3 mb-1.5 text-[11.5px] font-semibold text-white/55">Analytics</p>
          {NAV.slice(0, 9).map(({ href, icon, label }) => navLink(href, icon, label))}
          <p className="px-3 mt-4 mb-1.5 text-[11.5px] font-semibold text-white/55">Management</p>
          {NAV.slice(9).map(({ href, icon, label }) => navLink(href, icon, label))}
        </nav>

        {/* A "System Online — all services operational" card used to sit here.
            It was hardcoded: it never checked a service and said the same thing
            while the backend was down. Tutor Monitor reports real health, so
            the claim belongs there, not as decoration in the sidebar. */}

        <div className="px-3 pt-3 pb-4 relative border-t border-white/10">
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute bottom-[calc(100%+6px)] left-3 right-3 z-30 bg-[var(--card)] rounded-card border border-[var(--border)] shadow-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3.5 bg-[var(--surface)] border-b border-[var(--border)]">
                  <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                    {user.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] text-label font-semibold">
                        {user.name?.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-label font-semibold text-[var(--text)] truncate">{user.name}</p>
                    <p className="text-caption text-[var(--muted)] truncate">{user.email}</p>
                  </div>
                </div>

                <div className="py-1.5">
                  <Link
                    href="/admin/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-2.5 text-label text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
                  >
                    <i className="fas fa-user w-4 text-center text-[12px] text-[var(--muted)]" aria-hidden="true" />
                    Admin Profile
                  </Link>
                </div>

                <div className="border-t border-[var(--border)] py-1.5">
                  <button
                    onClick={() => { setUserMenuOpen(false); logout(); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-label text-red-700 hover:bg-red-50 transition-colors"
                  >
                    <i className="fas fa-right-from-bracket w-4 text-center text-[12px]" aria-hidden="true" />
                    Log out
                  </button>
                </div>
              </div>
            </>
          )}

          <button
            onClick={() => setUserMenuOpen(v => !v)}
            aria-expanded={userMenuOpen}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2 rounded-control transition-colors text-left',
              userMenuOpen ? 'bg-white/12' : 'hover:bg-white/8'
            )}
          >
            <div className="w-7 h-7 rounded-full overflow-hidden shrink-0">
              {user.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-white/15 ring-1 ring-white/20 flex items-center justify-center text-white text-caption font-semibold">
                  {user.name?.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-caption font-medium text-white truncate">{user.name}</p>
            </div>
            <i className={cn(
              'fas fa-chevron-up text-[10px] text-white/60 transition-transform shrink-0',
              !userMenuOpen && 'rotate-180'
            )} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-h-screen">
        <main className="flex-1 p-8 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
