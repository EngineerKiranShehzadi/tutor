'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { User } from '@/types';
import { authApi } from '@/lib/api';

interface AuthContextValue {
  user:      User | null;
  isLoading: boolean;
  setUser:   (user: User | null) => void;
  logout:    () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const [user,      setUser]   = useState<User | null>(null);
  const [isLoading, setLoading] = useState(true);

  // getMe fires exactly once here — all consumers share this single result
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) { setLoading(false); return; }
    authApi.getMe()
      .then(({ data }) => {
        setUser(data.data);
        console.log(`[AUTH] ✅ Session restored: ${data.data.email} (${data.data.role})`);
      })
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          localStorage.removeItem('accessToken');
          console.warn('[AUTH] ⚠️ Token invalid or expired, cleared');
        } else {
          console.warn('[AUTH] ⚠️ Could not reach server, keeping token for retry');
        }
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

  return (
    <AuthContext.Provider value={{ user, isLoading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuthContext = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within <AuthProvider>');
  return ctx;
};
