'use client';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  email: string;
  otp: string[];
  countdown: number;
  canResend: boolean;
  error: string;
  resendError: string;
  onOtpChange: (index: number, value: string) => void;
  onOtpKeyDown: (index: number, e: React.KeyboardEvent<HTMLInputElement>) => void;
  onVerify: (e: React.FormEvent) => void;
  onResend: () => void;
  isVerifying: boolean;
  isResending: boolean;
  message?: string;
}

export const OtpVerificationStep = ({
  email,
  otp,
  countdown,
  canResend,
  error,
  resendError,
  onOtpChange,
  onOtpKeyDown,
  onVerify,
  onResend,
  isVerifying,
  isResending,
  message,
}: Props) => {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null, null]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  return (
    <div>
      <h2 className="text-[26px] font-bold mb-2 text-[var(--text)]">Verify your email</h2>
      <p className="text-[15px] text-[var(--muted)] mb-7">
        {message || `A 5-digit code has been sent to `}
        <strong className="text-[var(--text)]">{email}</strong>
      </p>

      <form onSubmit={onVerify} className="flex flex-col gap-5">
        <div className="flex gap-2.5 justify-center">
          {otp.map((digit, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={e => onOtpChange(i, e.target.value)}
              onKeyDown={e => onOtpKeyDown(i, e)}
              className="w-14 text-center text-2xl font-bold border-[1.5px] rounded-lg outline-none transition-all bg-[var(--surface)] text-[var(--text)] border-[var(--border)] focus:border-[var(--red)]"
              style={{ height: '62px' }}
            />
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-[14px] text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation" /> {error}
          </div>
        )}

        <div className="text-center text-[15px] text-[var(--muted)]">
          {canResend ? (
            <button
              type="button"
              onClick={onResend}
              disabled={isResending}
              className="text-[var(--accent)] font-semibold hover:underline disabled:opacity-50"
            >
              {isResending ? 'Sending...' : 'Resend code'}
            </button>
          ) : (
            <span>Resend in <strong className="text-[var(--text)]">{countdown}s</strong></span>
          )}
        </div>

        {resendError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-[14px] text-red-600 flex items-center gap-2">
            <i className="fas fa-circle-exclamation" /> {resendError}
          </div>
        )}

        <Button type="submit" size="lg" loading={isVerifying} className="w-full rounded-lg">
          <i className="fas fa-check" /> Verify & Continue
        </Button>
      </form>
    </div>
  );
};
