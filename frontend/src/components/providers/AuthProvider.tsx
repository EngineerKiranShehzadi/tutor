'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { User } from '@/types';
import { authApi } from '@/lib/api';
import { refreshAccessToken, setAccessToken } from '@/lib/auth-token';

interface AuthContextValue {
  user:      User | null;
  isLoading: boolean;
  setUser:   (user: User | null) => void;
  logout:    () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const [user,      setUser]   = useState<User | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Runs once per page load. The access token is kept only in memory
  // (lib/auth-token.ts), so a session is restored from the httpOnly refresh
  // cookie: refresh first, then getMe. All consumers share this single result.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await refreshAccessToken();
        if (!token || cancelled) return;
        const { data } = await authApi.getMe();
        if (!cancelled) {
          setUser(data.data);
          console.log(`[AUTH] ✅ Session restored: ${data.data.email} (${data.data.role})`);
        }
      } catch {
        if (!cancelled) setAccessToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const endSession = useCallback(async (call: () => Promise<unknown>) => {
    try { await call(); } catch { /* ignore */ }
    setAccessToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  const logout    = useCallback(() => endSession(authApi.logout), [endSession]);
  // Ends every session of this account, on every device.
  const logoutAll = useCallback(() => endSession(authApi.logoutAll), [endSession]);

  return (
    <AuthContext.Provider value={{ user, isLoading, setUser, logout, logoutAll }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuthContext = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within <AuthProvider>');
  return ctx;
};
