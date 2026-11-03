'use client';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApolloError } from '@apollo/client';
import { AuthCard } from '@/components/auth/AuthCard';
import { Logo } from '@/components/ui/Logo';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useSignup } from '@/hooks/useSignup';
import { useResendSignupOtp } from '@/hooks/useResendSignupOtp';
import { useVerifySignupOtp } from '@/hooks/useVerifySignupOtp';
import { useAuth } from '@/hooks/useAuth';
import { setAccessToken } from '@/lib/auth-token';

type Step = 'form' | 'otp';

const schema = z.object({
  name:            z.string().min(2, 'Name must be at least 2 characters').max(100),
  email:           z.string().email('Enter a valid email'),
  password:        z.string()
    .min(8, 'At least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
  confirmPassword: z.string().min(1, 'Please confirm your password'),
}).refine(data => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});
type FormData = z.infer<typeof schema>;

const extractMessage = (err: unknown): string => {
  const ae = err as ApolloError | undefined;
  if (ae?.graphQLErrors?.length) return ae.graphQLErrors[0].message;
  if (ae?.networkError) return 'Network error. Please check your connection.';
  if (ae?.message) return ae.message;
  return 'Something went wrong. Please try again.';
};

export default function SignupPage() {
  const router = useRouter();
  const { user, isLoading, setUser } = useAuth();
  const [step, setStep] = useState<Step>('form');
  const [pendingEmail, setPendingEmail] = useState('');
  const [signupMessage, setSignupMessage] = useState('');
  const [serverError, setServerError] = useState('');

  // Redirect already-logged-in users away from this page
  useEffect(() => {
    if (!isLoading && user) {
      router.replace(user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    }
  }, [user, isLoading, router]);

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [resendError, setResendError] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null, null]);

  const [countdown, setCountdown] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { mutateAsync: signup, isLoading: signupLoading } = useSignup();
  const { mutateAsync: resendOtp, isLoading: resendLoading } = useResendSignupOtp();
  const { mutateAsync: verifyOtp, isLoading: verifyLoading } = useVerifySignupOtp();

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const startCountdown = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    let secs = 60;
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
    if (value && i < 5) inputRefs.current[i + 1]?.focus();
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) inputRefs.current[i - 1]?.focus();
  };

  const onSubmit = async (data: FormData) => {
    setServerError('');
    try {
      const result = await signup(data.name, data.email, data.password);
      setPendingEmail(result.email);
      setSignupMessage(result.message);
      startCountdown();
      setStep('otp');
    } catch (err) {
      setServerError(extractMessage(err));
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 6) { setOtpError('Enter the complete 6-digit code'); return; }
    try {
      // Verifying signs the user in (the server has set the refresh cookie);
      // finish exactly as a successful login does.
      const result = await verifyOtp(pendingEmail, code);
      setAccessToken(result.accessToken);
      setUser(result.user);
      router.replace(result.user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
    } catch (err) {
      setOtpError(extractMessage(err));
      setDigits(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    }
  };

  const handleResend = async () => {
    setResendError('');
    setOtpError('');
    try {
      await resendOtp(pendingEmail);
      setDigits(['', '', '', '', '', '']);
      startCountdown();
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (err) {
      setResendError(extractMessage(err));
    }
  };

  // OTP step
  if (step === 'otp') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => setStep('form')}
          className="flex items-center gap-1.5 text-[13px] text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-6"
        >
          <i className="fas fa-arrow-left text-[11px]" /> Back
        </button>
        <h1 className="text-h1 font-semibold text-[var(--text)] mb-2">Verify your email</h1>
        <p className="text-body text-[var(--muted)] mb-8">
          {signupMessage} <strong className="text-[var(--text)]">{pendingEmail}</strong>
        </p>

        <form onSubmit={handleOtpSubmit} className="flex flex-col gap-5">
          <div className="flex gap-2.5 justify-center">
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={e => handleDigitChange(i, e.target.value)}
                onKeyDown={e => handleDigitKeyDown(i, e)}
                className="w-12 h-14 text-center text-xl font-bold border border-[var(--border)] rounded-control outline-none transition-all bg-white text-[var(--text)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              />
            ))}
          </div>

          {otpError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[13px] text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation shrink-0" /> {otpError}
            </div>
          )}

          <div className="text-center text-[13px] text-[var(--muted)]">
            {canResend ? (
              <button type="button" onClick={handleResend} disabled={resendLoading}
                className="text-[var(--accent)] font-semibold hover:underline disabled:opacity-50">
                {resendLoading ? 'Sending…' : 'Resend code'}
              </button>
            ) : (
              <span>Resend in <strong className="text-[var(--text)]">{countdown}s</strong></span>
            )}
          </div>

          {resendError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[13px] text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation shrink-0" /> {resendError}
            </div>
          )}

          <Button type="submit" size="lg" loading={verifyLoading}
            className="w-full">
            <i className="fas fa-check text-[12px]" /> Verify & Continue
          </Button>
        </form>
      </AuthCard>
    );
  }

  // Signup form
  return (
    <AuthCard>
      {/* Heading */}
      <h1 className="text-h1 font-semibold text-[var(--text)] mb-2">Create your account</h1>
      <p className="text-body text-[var(--muted)] mb-8">
        One account, then pick a lecture and start asking.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">

        {/* Full Name */}
        <div className="flex flex-col gap-1.5">
          <label className="text-label font-medium text-[var(--muted)]">Full Name</label>
          <Input
            iconInField="fas fa-user"
            type="text"
            placeholder="Sara Ahmed"
            error={errors.name?.message}
            
            {...register('name')}
          />
        </div>

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
          <label className="text-label font-medium text-[var(--muted)]">Password</label>
          <Input
            iconInField="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Min 8 chars, 1 uppercase, 1 number"
            error={errors.password?.message}
            
            {...register('password')}
          />
        </div>

        {/* Confirm Password */}
        <div className="flex flex-col gap-1.5">
          <label className="text-label font-medium text-[var(--muted)]">Confirm Password</label>
          <Input
            iconInField="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Repeat your password"
            error={errors.confirmPassword?.message}
            
            {...register('confirmPassword')}
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
          loading={signupLoading}
          className="mt-1 w-full"
        >
          Create Account
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
        Already have an account?{' '}
        <Link href="/login" className="text-[var(--accent)] font-semibold hover:underline">
          Sign In
        </Link>
      </p>
    </AuthCard>
  );
}
