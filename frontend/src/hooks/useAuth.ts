'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { User } from '@/types';
import { authApi } from '@/lib/api';

// ── DEV BYPASS ───────────────────────────────────────────────────────────────
// Set to false (and restore the two commented lines below) to re-enable real auth
const DEV_BYPASS_AUTH = true;
const DEV_MOCK_USER: User = { id: 'dev-admin', name: 'Dev Admin', email: 'admin@askaitutor.com', role: 'ADMIN' };
// ─────────────────────────────────────────────────────────────────────────────

export const useAuth = () => {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(DEV_BYPASS_AUTH ? DEV_MOCK_USER : null); // real auth: null
  const [isLoading, setLoading] = useState(DEV_BYPASS_AUTH ? false : true);              // real auth: true

  useEffect(() => {
    if (DEV_BYPASS_AUTH) return; // ── remove this line to re-enable real auth ──
    const token = localStorage.getItem('accessToken');
    if (!token) { setLoading(false); return; }
    authApi.getMe()
      .then(({ data }) => {
        setUser(data.data);
        console.log(`[AUTH] ✅ Session restored: ${data.data.email} (${data.data.role})`);
      })
      .catch(() => {
        localStorage.removeItem('accessToken');
        console.warn('[AUTH] ⚠️ Token invalid or expired, cleared');
      })
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* ignore */ }
    localStorage.removeItem('accessToken');
    setUser(null);
    console.log('[AUTH] ✅ Logged out');
    router.push('/login');
  }, [router]);

  return { user, isLoading, logout, setUser };
};
