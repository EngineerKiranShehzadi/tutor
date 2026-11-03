'use client';
import Link from 'next/link';
import { Suspense, useState, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AxiosError } from 'axios';
import { AuthCard } from '@/components/auth/AuthCard';
import { Logo } from '@/components/ui/Logo';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLogin } from '@/hooks/useLogin';
import { useResendLoginOtp } from '@/hooks/useResendLoginOtp';
import { useVerifySignupOtp } from '@/hooks/useVerifySignupOtp';
import { ForgotPasswordFlow } from '@/components/auth/ForgotPasswordFlow';
import { useAuth } from '@/hooks/useAuth';
import { setAccessToken } from '@/lib/auth-token';

type Mode = 'login' | 'forgot' | 'verify';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type FormData = z.infer<typeof schema>;

const OAUTH_ERRORS: Record<string, string> = {
  oauth_failed:           'Google sign-in failed. Please try again or use email and password.',
  oauth_unverified_email: 'Google has not verified that email address, so it cannot be used to sign in.',
  oauth_account_exists:   'An account with this email already exists. Log in with your email and password.',
};

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>('login');
  const [serverError, setServerError] = useState(
    OAUTH_ERRORS[searchParams.get('error') ?? ''] ?? ''
  );

  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyExpires, setVerifyExpires] = useState(0);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [resendError, setResendError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { user, isLoading, setUser } = useAuth();
  const { login } = useLogin();

  // Redirect already-logged-in users away from this page
  useEffect(() => {
    if (!isLoading && user) {
      router.replace(user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    }
  }, [user, isLoading, router]);
  const { resendOtp, isLoading: resendLoading, getErrorMessage: getResendError } = useResendLoginOtp();
  const { mutateAsync: verifyOtp, isLoading: verifyLoading } = useVerifySignupOtp();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const startCountdown = (seconds: number) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    let secs = seconds;
    setCountdown(secs);
    setCanResend(false);
    intervalRef.current = setInterval(() => {
      secs--;
      setCountdown(secs);
      if (secs <= 0) {
        clearInterval(intervalRef.current!);
        intervalRef.current = null;
        setCanResend(true);
      }
    }, 1000);
  };

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const handleDigitChange = (i: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...digits];
    next[i] = value.slice(-1);
    setDigits(next);
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.target as HTMLInputElement;
    if (digits[i] && e.key !== 'Backspace' && i < 5) {
      const nextInput = el.parentElement?.parentElement?.children[i + 1]?.querySelector('input') as HTMLInputElement;
      nextInput?.focus();
    }
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      const prevInput = el.parentElement?.parentElement?.children[i - 1]?.querySelector('input') as HTMLInputElement;
      prevInput?.focus();
    }
  };

  const onSubmit = async (data: FormData) => {
    setServerError('');
    try {
      const result = await login(data.email, data.password);
      if (result.status === 'AUTHENTICATED') {
        setAccessToken(result.accessToken);
        setUser(result.user);
        router.push(result.user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
      } else if (result.status === 'EMAIL_VERIFICATION_REQUIRED') {
        setVerifyEmail(result.email);
        setVerifyExpires(result.verificationExpiresInSeconds);
        startCountdown(result.verificationExpiresInSeconds);
        setDigits(['', '', '', '', '', '']);
        setOtpError('');
        setResendError('');
        setMode('verify');
      }
    } catch (e) {
      const err = e as AxiosError<{ message: string }>;
      setServerError(err.response?.data?.message ?? 'Login failed. Please try again.');
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 6) { setOtpError('Enter the complete 6-digit code'); return; }
    try {
      const result = await verifyOtp(verifyEmail, code);
      setAccessToken(result.accessToken);
      setUser(result.user);
      router.push(result.user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    } catch (err: unknown) {
      const ae = err as any;
      setOtpError(ae?.response?.data?.message || ae?.message || 'Verification failed. Please try again.');
      setDigits(['', '', '', '', '', '']);
    }
  };

  const handleResend = async () => {
    setResendError('');
    setOtpError('');
    try {
      const expiresInSeconds = await resendOtp(verifyEmail);
      setDigits(['', '', '', '', '', '']);
      startCountdown(expiresInSeconds);
    } catch (err: unknown) {
      setResendError(getResendError(err));
    }
  };

  if (mode === 'forgot') return <ForgotPasswordFlow onBack={() => setMode('login')} />;

  if (mode === 'verify') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => { setMode('login'); setDigits(['', '', '', '', '', '']); }}
          className="flex items-center gap-1.5 text-[13px] text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-6"
        >
          <i className="fas fa-arrow-left text-[11px]" /> Back to Sign In
        </button>
        <OtpVerificationStep
          email={verifyEmail}
          otp={digits}
          countdown={countdown}
          canResend={canResend}
          error={otpError}
          resendError={resendError}
          onOtpChange={handleDigitChange}
          onOtpKeyDown={handleDigitKeyDown}
          onVerify={handleOtpSubmit}
          onResend={handleResend}
          isVerifying={verifyLoading}
          isResending={resendLoading}
          message="A 6-digit code has been sent to "
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      {/* Heading */}
      <h1 className="text-h1 font-semibold text-[var(--text)] mb-2">Welcome back</h1>
      <p className="text-body text-[var(--muted)] mb-8">
        Please enter your credentials to access your dashboard.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">

        {/* Email */}
        <div className="flex flex-col gap-1.5">
          <label className="text-label font-medium text-[var(--muted)]">Email</label>
          <Input
            iconInField="fas fa-envelope"
            type="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            
            {...register('email')}
          />
        </div>

        {/* Password */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-label font-medium text-[var(--muted)]">Password</label>
            <button
              type="button"
              onClick={() => setMode('forgot')}
              className="text-caption text-[var(--accent)] hover:underline font-medium"
            >
              Forgot password?
            </button>
          </div>
          <Input
            iconInField="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="••••••••"
            error={errors.password?.message}
            
            {...register('password')}
          />
        </div>

        {serverError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[14px] text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation shrink-0" /> {serverError}
          </div>
        )}

        <Button
          type="submit"
          size="lg"
          loading={isSubmitting}
          className="mt-1 w-full"
        >
          Sign In
        </Button>

        <div className="relative flex items-center gap-3">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <span className="text-caption text-[var(--muted2)]">or</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        <GoogleButton />
      </form>

      {/* Footer */}
      <p className="text-center text-label text-[var(--muted)] mt-8">
        New to AskAITutor?{' '}
        <Link href="/signup" className="text-[var(--accent)] font-semibold hover:underline">
          Sign Up
        </Link>
      </p>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
