'use client';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApolloError } from '@apollo/client';
import { AuthCard }    from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { Input }  from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useSignup }           from '@/hooks/useSignup';
import { useResendSignupOtp }  from '@/hooks/useResendSignupOtp';
import { useVerifySignupOtp }  from '@/hooks/useVerifySignupOtp';

type Step = 'form' | 'otp';

const schema = z.object({
  name:     z.string().min(2, 'Name must be at least 2 characters').max(100),
  email:    z.string().email('Enter a valid email'),
  password: z.string()
    .min(8, 'At least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
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
  const [step, setStep]               = useState<Step>('form');
  const [pendingEmail, setPendingEmail] = useState('');
  const [signupMessage, setSignupMessage] = useState('');
  const [serverError, setServerError] = useState('');

  // OTP state
  const [digits, setDigits]   = useState<string[]>(['', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [resendError, setResendError] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null]);

  // Countdown
  const [countdown, setCountdown] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { mutateAsync: signup, isLoading: signupLoading } = useSignup();
  const { mutateAsync: resendOtp, isLoading: resendLoading } = useResendSignupOtp();
  const { mutateAsync: verifyOtp, isLoading: verifyLoading } = useVerifySignupOtp();

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  // ── Countdown ──────────────────────────────────────────
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

  // ── OTP digit handlers ─────────────────────────────────
  const handleDigitChange = (i: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...digits];
    next[i] = value.slice(-1);
    setDigits(next);
    if (value && i < 4) inputRefs.current[i + 1]?.focus();
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) inputRefs.current[i - 1]?.focus();
  };

  // ── Step 1: Signup form ────────────────────────────────
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

  // ── Step 2: Verify OTP ────────────────────────────────
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 5) { setOtpError('Enter the complete 5-digit code'); return; }
    try {
      const result = await verifyOtp(pendingEmail, code);
      localStorage.setItem('accessToken', result.accessToken);
      router.push('/courses');
    } catch (err) {
      setOtpError(extractMessage(err));
      setDigits(['', '', '', '', '']);
      inputRefs.current[0]?.focus();
    }
  };

  const handleResend = async () => {
    setResendError('');
    setOtpError('');
    try {
      await resendOtp(pendingEmail);
      setDigits(['', '', '', '', '']);
      startCountdown();
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (err) {
      setResendError(extractMessage(err));
    }
  };

  // ── Render: OTP step ──────────────────────────────────
  if (step === 'otp') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => setStep('form')}
          className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-5"
        >
          <i className="fas fa-arrow-left" /> Back
        </button>
        <h2 className="text-xl font-bold mb-1 text-[var(--text)]">Verify your email</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          {signupMessage} <strong>{pendingEmail}</strong>
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
                className="w-11 text-center text-xl font-bold border-[1.5px] rounded-lg outline-none transition-all bg-white text-[var(--text)] placeholder:text-[var(--muted2)] border-[var(--border)] focus:border-[var(--red)] focus:ring-2 focus:ring-red-50"
                style={{ height: '52px' }}
              />
            ))}
          </div>

          {otpError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation" /> {otpError}
            </div>
          )}

          <div className="text-center text-sm text-[var(--muted)]">
            {canResend ? (
              <button
                type="button"
                onClick={handleResend}
                disabled={resendLoading}
                className="text-[var(--accent)] font-semibold hover:underline disabled:opacity-50"
              >
                {resendLoading ? 'Sending...' : 'Resend code'}
              </button>
            ) : (
              <span>Resend in <strong className="text-[var(--text)]">{countdown}s</strong></span>
            )}
          </div>

          {resendError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation" /> {resendError}
            </div>
          )}

          <Button type="submit" size="lg" loading={verifyLoading} className="w-full rounded-lg">
            <i className="fas fa-check" /> Verify & Continue
          </Button>
        </form>
      </AuthCard>
    );
  }

  // ── Render: Signup form ───────────────────────────────
  return (
    <AuthCard>
      <div className="flex border-b border-[var(--border)] mb-7">
        <Link href="/login" className="flex-1 py-2.5 text-center text-sm font-semibold text-[var(--muted)] hover:text-[var(--text)] transition-colors">
          Sign In
        </Link>
        <span className="flex-1 py-2.5 text-center text-sm font-semibold text-[var(--red)] border-b-2 border-[var(--red)] mb-[-1px]">
          Sign Up
        </span>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Input label="Full Name" icon="fas fa-user" type="text" placeholder="Kiran Shehzadi"
          error={errors.name?.message} {...register('name')} />
        <Input label="Email" icon="fas fa-envelope" type="email" placeholder="you@example.com"
          error={errors.email?.message} {...register('email')} />
        <Input label="Password" icon="fas fa-lock" type="password" placeholder="Min 8 chars, 1 uppercase, 1 number"
          error={errors.password?.message} {...register('password')} />

        {serverError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation" /> {serverError}
          </div>
        )}

        <Button type="submit" size="lg" loading={signupLoading} className="mt-1 w-full rounded-lg">
          <i className="fas fa-user-plus" /> Create Account
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
