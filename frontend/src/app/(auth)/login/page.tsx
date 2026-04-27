'use client';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AxiosError } from 'axios';
import { AuthCard } from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLogin } from '@/hooks/useLogin';
import { useResendLoginOtp } from '@/hooks/useResendLoginOtp';
import { useVerifySignupOtp } from '@/hooks/useVerifySignupOtp';

type Mode = 'login' | 'forgot' | 'verify';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type FormData = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [serverError, setServerError] = useState('');

  // Verify state
  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyExpires, setVerifyExpires] = useState(0);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [resendError, setResendError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { login } = useLogin();
  const { resendOtp, isLoading: resendLoading, getErrorMessage: getResendError } = useResendLoginOtp();
  const { mutateAsync: verifyOtp, isLoading: verifyLoading } = useVerifySignupOtp();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  // ── Countdown ──────────────────────────────────────────
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

  // ── OTP digit handlers ─────────────────────────────────
  const handleDigitChange = (i: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...digits];
    next[i] = value.slice(-1);
    setDigits(next);
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    // Auto-focus next on input
    if (digits[i] && e.key !== 'Backspace' && i < 4) {
      const nextInput = (e.target.parentElement?.nextElementSibling as HTMLInputElement) ||
                        (e.target.parentElement?.parentElement?.children[i + 1]?.querySelector('input') as HTMLInputElement);
      nextInput?.focus();
    }
    // Go back on backspace if empty
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      const prevInput = (e.target.parentElement?.previousElementSibling as HTMLInputElement) ||
                        (e.target.parentElement?.parentElement?.children[i - 1]?.querySelector('input') as HTMLInputElement);
      prevInput?.focus();
    }
  };

  // ── Step 1: Login form ─────────────────────────────────
  const onSubmit = async (data: FormData) => {
    setServerError('');
    try {
      const result = await login(data.email, data.password);

      if (result.status === 'AUTHENTICATED') {
        // Success: store token and redirect
        localStorage.setItem('accessToken', result.accessToken);
        router.push('/courses');
      } else if (result.status === 'EMAIL_VERIFICATION_REQUIRED') {
        // Email not verified: switch to verify mode
        setVerifyEmail(result.email);
        setVerifyExpires(result.verificationExpiresInSeconds);
        startCountdown(result.verificationExpiresInSeconds);
        setDigits(['', '', '', '', '']);
        setOtpError('');
        setResendError('');
        setMode('verify');
      }
    } catch (e) {
      const err = e as AxiosError<{ message: string }>;
      setServerError(err.response?.data?.message ?? 'Login failed. Please try again.');
    }
  };

  // ── Step 2: Verify OTP ─────────────────────────────────
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 5) {
      setOtpError('Enter the complete 5-digit code');
      return;
    }
    try {
      const result = await verifyOtp(verifyEmail, code);
      localStorage.setItem('accessToken', result.accessToken);
      router.push('/courses');
    } catch (err: unknown) {
      const ae = err as any;
      const message = ae?.response?.data?.message || ae?.message || 'Verification failed. Please try again.';
      setOtpError(message);
      setDigits(['', '', '', '', '']);
    }
  };

  const handleResend = async () => {
    setResendError('');
    setOtpError('');
    try {
      const expiresInSeconds = await resendOtp(verifyEmail);
      setDigits(['', '', '', '', '']);
      startCountdown(expiresInSeconds);
    } catch (err: unknown) {
      setResendError(getResendError(err));
    }
  };

  // ── Render: Verify mode ────────────────────────────────
  if (mode === 'verify') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => { setMode('login'); setDigits(['', '', '', '', '']); }}
          className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-5"
        >
          <i className="fas fa-arrow-left" /> Back
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
          message={`A 5-digit code has been sent to `}
        />
      </AuthCard>
    );
  }

  // ── Render: Login form ─────────────────────────────────
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
          <button
            type="button"
            onClick={() => setMode('forgot')}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            Forgot password?
          </button>
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
