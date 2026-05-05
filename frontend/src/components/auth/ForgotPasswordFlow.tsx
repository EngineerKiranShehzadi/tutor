'use client';
import { useState, useRef, useEffect } from 'react';
import { ApolloError } from '@apollo/client';
import { AuthCard } from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useRequestPasswordReset } from '@/hooks/useRequestPasswordReset';
import { useResendPasswordResetOtp } from '@/hooks/useResendPasswordResetOtp';
import { useVerifyOtp } from '@/hooks/useVerifyOtp';
import { useResetPassword } from '@/hooks/useResetPassword';

type Step = 'email' | 'otp' | 'reset' | 'success';

interface Props {
  onBack: () => void;
}

const extractMessage = (err: unknown): string => {
  const ae = err as ApolloError | undefined;
  if (ae?.graphQLErrors?.length) return ae.graphQLErrors[0].message;
  if (ae?.networkError) return 'Network error. Please check your connection.';
  if (ae?.message) return ae.message;
  return 'Something went wrong. Please try again.';
};

export function ForgotPasswordFlow({ onBack }: Props) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');

  // Per-step error states
  const [emailError, setEmailError]   = useState('');
  const [otpError, setOtpError]       = useState('');
  const [resendError, setResendError] = useState('');
  const [resetError, setResetError]   = useState('');

  // OTP: 5 individual digit inputs
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null]);

  // Resend countdown
  const [countdown, setCountdown] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Password fields
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Hooks
  const { mutateAsync: requestReset, isLoading: emailLoading }   = useRequestPasswordReset();
  const { mutateAsync: resendOtp,    isLoading: resendLoading }   = useResendPasswordResetOtp();
  const { mutateAsync: verifyOtp,    isLoading: otpLoading }      = useVerifyOtp();
  const { mutateAsync: resetPwd,     isLoading: resetLoading }    = useResetPassword();

  // ── Countdown ─────────────────────────────────────────
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

  // ── OTP digit handlers ────────────────────────────────
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

  // ── Step: Email ───────────────────────────────────────
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError('');
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) { setEmailError('Email is required'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setEmailError('Enter a valid email'); return; }
    try {
      await requestReset(trimmed);
      startCountdown();
      setStep('otp');
    } catch (err) {
      setEmailError(extractMessage(err));
    }
  };

  // ── Step: OTP ─────────────────────────────────────────
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    const code = digits.join('');
    if (code.length !== 5) { setOtpError('Enter the complete 5-digit OTP'); return; }
    try {
      await verifyOtp(email, code);
      setStep('reset');
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
      await resendOtp(email);
      setDigits(['', '', '', '', '']);
      startCountdown();
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (err) {
      setResendError(extractMessage(err));
    }
  };

  // ── Step: Reset ───────────────────────────────────────
  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    if (!newPassword) { setResetError('Password is required'); return; }
    if (newPassword.length < 8) { setResetError('At least 8 characters'); return; }
    if (!/[A-Z]/.test(newPassword)) { setResetError('Must contain an uppercase letter'); return; }
    if (!/[0-9]/.test(newPassword)) { setResetError('Must contain a number'); return; }
    if (newPassword !== confirmPassword) { setResetError('Passwords do not match'); return; }
    try {
      await resetPwd(email, newPassword, confirmPassword);
      setStep('success');
    } catch (err) {
      setResetError(extractMessage(err));
    }
  };

  // ── Render ────────────────────────────────────────────
  if (step === 'email') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-5"
        >
          <i className="fas fa-arrow-left" /> Back to Sign In
        </button>
        <h2 className="text-xl font-bold mb-1 text-[var(--text)]">Forgot Password</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          Enter your email and we'll send a 5-digit OTP.
        </p>
        <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
          <Input
            label="Email"
            icon="fas fa-envelope"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            error={emailError}
          />
          <Button type="submit" size="lg" loading={emailLoading} className="w-full rounded-lg mt-1">
            <i className="fas fa-paper-plane" /> Send OTP
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (step === 'otp') {
    return (
      <AuthCard>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-5"
        >
          <i className="fas fa-arrow-left" /> Back to Sign In
        </button>
        <h2 className="text-xl font-bold mb-1 text-[var(--text)]">Enter OTP</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          We sent a 5-digit code to <strong>{email}</strong>. Valid for 60 seconds.
        </p>
        <form onSubmit={handleOtpSubmit} className="flex flex-col gap-5">
          {/* 5 digit inputs */}
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
                className="w-11 text-center text-xl font-bold border-[1.5px] rounded-lg outline-none transition-all bg-[var(--surface)] text-[var(--text)] border-[var(--border)] focus:border-[var(--red)]"
                style={{ height: '52px' }}
              />
            ))}
          </div>

          {otpError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation" /> {otpError}
            </div>
          )}

          {/* Resend countdown */}
          <div className="text-center text-sm text-[var(--muted)]">
            {canResend ? (
              <button
                type="button"
                onClick={handleResend}
                disabled={resendLoading}
                className="text-[var(--accent)] font-semibold hover:underline disabled:opacity-50"
              >
                {resendLoading ? 'Sending...' : 'Resend OTP'}
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

          <Button type="submit" size="lg" loading={otpLoading} className="w-full rounded-lg">
            <i className="fas fa-check" /> Verify OTP
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (step === 'reset') {
    return (
      <AuthCard>
        <h2 className="text-xl font-bold mb-1 text-[var(--text)]">New Password</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          Choose a strong password for your account.
        </p>
        <form onSubmit={handleResetSubmit} className="flex flex-col gap-4">
          <Input
            label="New Password"
            icon="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Min 8 chars, 1 uppercase, 1 number"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
          />
          <Input
            label="Confirm Password"
            icon="fas fa-lock"
            type="password"
            showPasswordToggle
            placeholder="Repeat password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
          />
          {resetError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-600 flex items-center gap-2">
              <i className="fas fa-circle-exclamation" /> {resetError}
            </div>
          )}
          <Button type="submit" size="lg" loading={resetLoading} className="w-full rounded-lg mt-1">
            <i className="fas fa-key" /> Reset Password
          </Button>
        </form>
      </AuthCard>
    );
  }

  // Step: success
  return (
    <AuthCard>
      <div className="flex flex-col items-center gap-5 py-4 text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
          <i className="fas fa-lock text-green-600 text-3xl" />
        </div>
        <div>
          <h2 className="text-xl font-bold mb-1 text-[var(--text)]">Password Reset!</h2>
          <p className="text-sm text-[var(--muted)]">
            Your password has been changed successfully.
          </p>
        </div>
        <Button size="lg" onClick={onBack} className="rounded-lg w-full">
          <i className="fas fa-sign-in-alt" /> Back to Sign In
        </Button>
      </div>
    </AuthCard>
  );
}
