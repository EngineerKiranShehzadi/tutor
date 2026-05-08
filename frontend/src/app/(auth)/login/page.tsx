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
import { ForgotPasswordFlow } from '@/components/auth/ForgotPasswordFlow';

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
    if (digits[i] && e.key !== 'Backspace' && i < 4) {
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
        localStorage.setItem('accessToken', result.accessToken);
        router.push(result.user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
      } else if (result.status === 'EMAIL_VERIFICATION_REQUIRED') {
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

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 5) { setOtpError('Enter the complete 5-digit code'); return; }
    try {
      const result = await verifyOtp(verifyEmail, code);
      localStorage.setItem('accessToken', result.accessToken);
      router.push(result.user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    } catch (err: unknown) {
      const ae = err as any;
      setOtpError(ae?.response?.data?.message || ae?.message || 'Verification failed. Please try again.');
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

  if (mode === 'forgot') return <ForgotPasswordFlow onBack={() => setMode('login')} />;

  if (mode === 'verify') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => { setMode('login'); setDigits(['', '', '', '', '']); }}
          className="flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-800 transition-colors mb-6"
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
          message="A 5-digit code has been sent to "
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      {/* Mobile logo (hidden on md — left panel covers it) */}
      <div className="mb-8 md:hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="AskAI Tutor" className="w-full object-contain" />
      </div>

      {/* Heading */}
      <h1 className="text-[24px] font-bold text-slate-900 mb-1">Welcome back</h1>
      <p className="text-[13px] text-slate-500 mb-6 leading-relaxed">
        Please enter your credentials to access your dashboard.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">

        {/* Email */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-semibold text-slate-700">Email</label>
          <Input
            iconInField="fas fa-envelope"
            type="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            className="bg-white border-slate-200 focus:border-[#065fd4] py-3"
            {...register('email')}
          />
        </div>

        {/* Password */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-semibold text-slate-700">Password</label>
            <button
              type="button"
              onClick={() => setMode('forgot')}
              className="text-[12px] text-[#065fd4] hover:underline font-medium"
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
            className="bg-white border-slate-200 focus:border-[#065fd4] py-3"
            {...register('password')}
          />
        </div>

        {serverError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[13px] text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation shrink-0" /> {serverError}
          </div>
        )}

        <Button
          type="submit"
          size="lg"
          loading={isSubmitting}
          className="mt-1 w-full rounded-lg py-3 text-[14px] font-semibold"
        >
          Sign In
        </Button>

        <div className="relative flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-[12px] text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        <GoogleButton />
      </form>

      {/* Footer */}
      <p className="text-center text-[13px] text-slate-500 mt-7">
        New to AskAITutor?{' '}
        <Link href="/signup" className="text-[#065fd4] font-semibold hover:underline">
          Sign Up
        </Link>
      </p>
    </AuthCard>
  );
}
