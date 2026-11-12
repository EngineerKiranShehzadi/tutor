'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Navbar } from '@/components/layout/Navbar';
import { LectureRetrievalWarmup } from '@/components/chat/LectureRetrievalWarmup';
import { StudentNavigationProvider } from '@/components/student/StudentNavigationProvider';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (isLoading) return;
    if (!user) router.replace('/login');
    else if (user.role === 'ADMIN') router.replace('/admin/dashboard');
  }, [user, isLoading, router]);
  if (isLoading || !user || user.role === 'ADMIN') {
    return <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]"><div role="status" aria-label="Restoring session" className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" /></div>;
  }
  return (
    <StudentNavigationProvider key={String(user.id)}>
      <div className="min-h-screen bg-[var(--bg)]">
        <Navbar />
        <LectureRetrievalWarmup userId={String(user.id)} />
        {children}
      </div>
    </StudentNavigationProvider>
  );
}
