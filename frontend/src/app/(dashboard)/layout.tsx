'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Navbar } from '@/components/layout/Navbar';

// Pages that manage their own layout (sidebar) — no top Navbar
const NO_NAVBAR_PATHS = ['/profile'];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      console.log('[GUARD] No session → /login');
      router.replace('/login');
    } else if (user.role === 'ADMIN') {
      console.log('[GUARD] Admin on student route → /admin/dashboard');
      router.replace('/admin/dashboard');
    }
  }, [user, isLoading, router]);

  if (isLoading || !user || user.role === 'ADMIN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const hideNavbar = NO_NAVBAR_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {!hideNavbar && <Navbar />}
      {children}
    </div>
  );
}
