'use client';
import { useCallback } from 'react';
import { LoginResult } from '@/types';
import { authApi } from '@/lib/api';

export const useLogin = () => {
  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const { data } = await authApi.login({ email, password });
    return data.data as LoginResult;
  }, []);

  return { login };
};
