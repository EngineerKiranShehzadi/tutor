'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { User } from '@/types';
import { authApi } from '@/lib/api';

export const useAuth = () => {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
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
