'use client';
import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?:    'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'primary', size = 'md', loading, className, children, disabled, ...props }, ref) => {
    const base  = 'inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed';
    const sizes = { sm: 'px-3.5 py-2 text-[13px]', md: 'px-5 py-2.5 text-[14px]', lg: 'px-7 py-3.5 text-[16px]' };
    const variants = {
      primary:   'bg-gradient-to-r from-[var(--red)] to-[var(--red2)] hover:opacity-90 text-white shadow-lg',
      secondary: 'bg-[var(--surface)] border border-[var(--border)] hover:bg-white/10 text-[var(--text)]',
      ghost:     'bg-transparent hover:bg-[var(--surface)] text-[var(--muted)]',
      danger:    'bg-red-600 hover:bg-red-700 text-white',
    };
    return (
      <button ref={ref} className={cn(base, sizes[size], variants[variant], className)} disabled={disabled || loading} {...props}>
        {loading && <i className="fas fa-circle-notch fa-spin text-sm" />}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';
