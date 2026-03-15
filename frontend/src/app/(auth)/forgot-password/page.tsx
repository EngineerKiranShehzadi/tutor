'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/AuthCard';
import { Input }    from '@/components/ui/Input';
import { Button }   from '@/components/ui/Button';
import { authApi }  from '@/lib/api';

const schema = z.object({ email: z.string().email('Enter a valid email') });
type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    await authApi.forgotPassword(data.email);
    setSent(true);
  };

  return (
    <AuthCard>
      <h2 className="text-xl font-bold mb-1 text-center">Forgot Password</h2>
      <p className="text-sm text-[var(--muted)] text-center mb-7">
        Enter your email and we&apos;ll send a reset link.
      </p>

      {sent ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
            <i className="fas fa-envelope-circle-check text-green-600 text-2xl" />
          </div>
          <p className="text-sm text-center text-[var(--muted)]">
            If that email is registered, a password reset link has been sent.<br/>
            Check your inbox and spam folder.
          </p>
          <Link href="/login" className="text-sm font-semibold text-[var(--accent)] hover:underline">
            Back to Sign In
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <Input label="Email" icon="fas fa-envelope" type="email" placeholder="you@example.com"
            error={errors.email?.message} {...register('email')} />

          <Button type="submit" size="lg" loading={isSubmitting} className="w-full rounded-lg mt-1">
            <i className="fas fa-paper-plane" /> Send Reset Link
          </Button>

          <Link href="/login" className="text-center text-sm text-[var(--muted)] hover:text-[var(--text)] transition-colors">
            <i className="fas fa-arrow-left mr-1" /> Back to Sign In
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
