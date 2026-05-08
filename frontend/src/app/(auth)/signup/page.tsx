'use client';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApolloError } from '@apollo/client';
import { AuthCard } from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useSignup } from '@/hooks/useSignup';
import { useResendSignupOtp } from '@/hooks/useResendSignupOtp';
import { useVerifySignupOtp } from '@/hooks/useVerifySignupOtp';

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
  const [step, setStep] = useState<Step>('form');
  const [pendingEmail, setPendingEmail] = useState('');
  const [signupMessage, setSignupMessage] = useState('');
  const [serverError, setServerError] = useState('');

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [resendError, setResendError] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null]);

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
    if (value && i < 4) inputRefs.current[i + 1]?.focus();
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

  // OTP step
  if (step === 'otp') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={() => setStep('form')}
          className="flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-800 transition-colors mb-6"
        >
          <i className="fas fa-arrow-left text-[11px]" /> Back
        </button>
        <h1 className="text-[26px] font-bold text-slate-900 mb-1">Verify your email</h1>
        <p className="text-[14px] text-slate-500 mb-8">
          {signupMessage} <strong className="text-slate-700">{pendingEmail}</strong>
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
                className="w-12 h-14 text-center text-xl font-bold border-[1.5px] border-slate-200 rounded-xl outline-none transition-all bg-white text-slate-900 focus:border-[#065fd4] focus:ring-2 focus:ring-blue-100"
              />
            ))}
          </div>

          {otpError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[13px] text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation shrink-0" /> {otpError}
            </div>
          )}

          <div className="text-center text-[13px] text-slate-500">
            {canResend ? (
              <button type="button" onClick={handleResend} disabled={resendLoading}
                className="text-[#065fd4] font-semibold hover:underline disabled:opacity-50">
                {resendLoading ? 'Sending…' : 'Resend code'}
              </button>
            ) : (
              <span>Resend in <strong className="text-slate-800">{countdown}s</strong></span>
            )}
          </div>

          {resendError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-[13px] text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation shrink-0" /> {resendError}
            </div>
          )}

          <Button type="submit" size="lg" loading={verifyLoading}
            className="w-full rounded-lg py-3 text-[14px] font-semibold">
            <i className="fas fa-check text-[12px]" /> Verify & Continue
          </Button>
        </form>
      </AuthCard>
    );
  }

  // Signup form
  return (
    <AuthCard>
      {/* Mobile logo */}
      <div className="mb-8 md:hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="AskAI Tutor" className="w-full object-contain" />
      </div>

      {/* Heading */}
      <h1 className="text-[24px] font-bold text-slate-900 mb-1">Create your account</h1>
      <p className="text-[13px] text-slate-500 mb-5 leading-relaxed">
        Join thousands of students learning smarter with AI.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">

        {/* Full Name */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-semibold text-slate-700">Full Name</label>
          <Input
            iconInField="fas fa-user"
            type="text"
            placeholder="Sara Ahmed"
            error={errors.name?.message}
            className="bg-white border-slate-200 focus:border-[#065fd4] py-3"
            {...register('name')}
          />
        </div>

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
          <label className="text-[13px] font-semibold text-slate-700">Password</label>
          <Input
            iconInField="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Min 8 chars, 1 uppercase, 1 number"
            error={errors.password?.message}
            className="bg-white border-slate-200 focus:border-[#065fd4] py-3"
            {...register('password')}
          />
        </div>

        {/* Confirm Password */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-semibold text-slate-700">Confirm Password</label>
          <Input
            iconInField="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Repeat your password"
            error={errors.confirmPassword?.message}
            className="bg-white border-slate-200 focus:border-[#065fd4] py-3"
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
          className="mt-1 w-full rounded-lg py-3 text-[14px] font-semibold"
        >
          Create Account <i className="fas fa-arrow-right text-[12px] ml-1" />
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
        Already have an account?{' '}
        <Link href="/login" className="text-[#065fd4] font-semibold hover:underline">
          Sign In
        </Link>
      </p>
    </AuthCard>
  );
}
