'use client';
import { useCallback, useState } from 'react';
import { authApi } from '@/lib/api';
import { AxiosError } from 'axios';

export const useResendLoginOtp = () => {
  const [isLoading, setLoading] = useState(false);

  const resendOtp = useCallback(async (email: string): Promise<number> => {
    setLoading(true);
    try {
      const { data } = await authApi.resendLoginOtp(email);
      return data.data.verificationExpiresInSeconds as number;
    } finally {
      setLoading(false);
    }
  }, []);

  const getErrorMessage = (error: unknown): string => {
    const err = error as AxiosError<{ message: string }>;
    return err?.response?.data?.message ?? err?.message ?? 'Failed to resend code.';
  };

  return { resendOtp, isLoading, getErrorMessage };
};
