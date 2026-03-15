'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AxiosError } from 'axios';
import { AuthCard }    from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { Input }  from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';

const schema = z.object({
  email:    z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type FormData = z.infer<typeof schema>;

export default function LoginPage() {
  const { login } = useAuth();
  const [serverError, setServerError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setServerError('');
    try {
      await login(data.email, data.password);
    } catch (e) {
      const err = e as AxiosError<{ message: string }>;
      setServerError(err.response?.data?.message ?? 'Login failed. Please try again.');
    }
  };

  return (
    <AuthCard>
      {/* Tabs */}
      <div className="flex border-b border-[var(--border)] mb-7">
        <span className="flex-1 py-2.5 text-center text-sm font-semibold text-[var(--red)] border-b-2 border-[var(--red)] mb-[-1px]">
          Sign In
        </span>
        <Link href="/signup" className="flex-1 py-2.5 text-center text-sm font-semibold text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Sign Up
        </Link>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Input label="Email" icon="fas fa-envelope" type="email" placeholder="you@example.com"
          error={errors.email?.message} {...register('email')} />
        <Input label="Password" icon="fas fa-lock" type="password" placeholder="••••••••"
          error={errors.password?.message} {...register('password')} />

        <div className="text-right -mt-1">
          <Link href="/forgot-password" className="text-xs text-[var(--accent)] hover:underline">
            Forgot password?
          </Link>
        </div>

        {serverError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation" /> {serverError}
          </div>
        )}

        <Button type="submit" size="lg" loading={isSubmitting} className="mt-1 w-full rounded-lg">
          <i className="fas fa-sign-in-alt" /> Sign In
        </Button>

        <div className="relative flex items-center gap-3 my-1">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <span className="text-xs text-[var(--muted2)]">or</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        <GoogleButton />
      </form>
    </AuthCard>
  );
}
