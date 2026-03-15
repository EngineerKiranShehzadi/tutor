'use client';
import { InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?:      string;
  icon?:       string;
  error?:      string;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, icon, error, className, ...props }, ref) => (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          {icon && <i className={`${icon} text-[10px]`} />}
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={cn(
          'w-full px-3.5 py-2.5 text-sm border-[1.5px] rounded-lg outline-none transition-all',
          'bg-white text-[var(--text)] placeholder:text-[var(--muted2)]',
          error
            ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
            : 'border-[var(--border)] focus:border-[var(--red)] focus:ring-2 focus:ring-red-50',
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-500 flex items-center gap-1"><i className="fas fa-circle-exclamation text-[10px]" />{error}</p>}
    </div>
  )
);
Input.displayName = 'Input';
