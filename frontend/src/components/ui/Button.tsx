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
    const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3 text-base' };
    const variants = {
      primary:   'bg-[var(--red)] hover:bg-[var(--red2)] text-white',
      secondary: 'bg-[var(--surface)] border border-[var(--border)] hover:bg-gray-200 text-[var(--text)]',
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
