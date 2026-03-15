'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AxiosError } from 'axios';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input }    from '@/components/ui/Input';
import { Button }   from '@/components/ui/Button';
import { authApi }  from '@/lib/api';

const schema = z.object({
  password: z.string()
    .min(8, 'At least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match', path: ['confirm'],
});
type FormData = z.infer<typeof schema>;

export default function ResetPasswordPage({ params }: { params: { token: string } }) {
  const [done, setDone]  = useState(false);
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setError('');
    try {
      await authApi.resetPassword(params.token, data.password);
      setDone(true);
    } catch (e) {
      const err = e as AxiosError<{ message: string }>;
      setError(err.response?.data?.message ?? 'Reset failed. The link may have expired.');
    }
  };

  return (
    <AuthCard>
      <h2 className="text-xl font-bold mb-1 text-center">Set New Password</h2>
      <p className="text-sm text-[var(--muted)] text-center mb-7">
        Choose a strong password for your account.
      </p>

      {done ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
            <i className="fas fa-lock text-green-600 text-2xl" />
          </div>
          <p className="text-sm text-center text-[var(--muted)]">
            Password reset successfully!
          </p>
          <Link href="/login">
            <Button size="lg" className="rounded-lg">
              <i className="fas fa-sign-in-alt" /> Sign In
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <Input label="New Password" icon="fas fa-lock" type="password"
            placeholder="Min 8 chars, 1 uppercase, 1 number"
            error={errors.password?.message} {...register('password')} />
          <Input label="Confirm Password" icon="fas fa-lock" type="password"
            placeholder="Repeat password"
            error={errors.confirm?.message} {...register('confirm')} />

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation" /> {error}
            </div>
          )}

          <Button type="submit" size="lg" loading={isSubmitting} className="w-full rounded-lg mt-1">
            <i className="fas fa-key" /> Reset Password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
