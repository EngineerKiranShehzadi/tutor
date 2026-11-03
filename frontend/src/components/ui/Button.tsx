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
    const base  = 'inline-flex items-center justify-center gap-2 font-semibold rounded-control transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed';
    // Fixed heights so a button lines up with a field of the same size.
    const sizes = { sm: 'h-9 px-4 text-caption', md: 'h-10 px-5 text-label', lg: 'h-11 px-6 text-label' };
    const variants = {
      // Flat, no gradient, no drop shadow: it is the only strong colour on the
      // page, so it does not need help being noticed.
      primary:   'bg-[var(--accent)] hover:bg-[var(--accent-deep)] text-white',
      secondary: 'bg-white border border-[var(--border)] hover:bg-[var(--surface)] text-[var(--text)]',
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
