'use client';
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

// The backend's Google callback sets only the httpOnly refresh cookie and
// redirects here (the access token is never put in a URL). AuthProvider, which
// mounts with this page load, turns that cookie into a session; this page just
// waits for it and moves on.
function GoogleCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    const error = params.get('error');
    if (error) { router.replace(`/login?error=${encodeURIComponent(error)}`); return; }
    if (isLoading) return;
    if (user) router.replace(user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    else router.replace('/login?error=oauth_failed');
  }, [params, router, user, isLoading]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3">
        <div className="w-9 h-9 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-slate-500 font-medium">Signing you in with Google…</span>
      </div>
    </div>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={null}>
      <GoogleCallbackInner />
    </Suspense>
  );
}
