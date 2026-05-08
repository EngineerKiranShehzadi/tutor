'use client';
import { InputHTMLAttributes, forwardRef, useState } from 'react';
import { cn } from '@/lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?:               string;
  icon?:                string;
  iconInField?:         string;
  error?:               string;
  showPasswordToggle?:  boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, icon, iconInField, error, className, showPasswordToggle, type, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    const resolvedType = showPasswordToggle ? (visible ? 'text' : 'password') : type;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            {icon && <i className={`${icon} text-[10px]`} />}
            {label}
          </label>
        )}
        <div className="relative">
          {iconInField && (
            <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none">
              <i className={`${iconInField} text-slate-400 text-[13px]`} />
            </div>
          )}
          <input
            ref={ref}
            type={resolvedType}
            className={cn(
              'w-full px-3.5 py-2.5 text-sm border-[1.5px] rounded-lg outline-none transition-all',
              'bg-[var(--surface)] text-[var(--text)] placeholder:text-[var(--muted2)]',
              /* Consistency: same focus ring as other inputs across the app */
              'focus:ring-2 focus:ring-blue-100',
              iconInField && 'pl-10',
              showPasswordToggle && 'pr-10',
              error
                ? 'border-red-400 focus:border-red-400 focus:ring-red-100'
                : 'border-[var(--border)] focus:border-[var(--red)]',
              className
            )}
            {...props}
          />
          {showPasswordToggle && (
            /* Affordance: aria-label announces purpose to screen readers */
            <button
              type="button"
              tabIndex={-1}
              aria-label={visible ? 'Hide password' : 'Show password'}
              onClick={() => setVisible(v => !v)}
              className="absolute inset-y-0 right-3 flex items-center text-[var(--muted)] hover:text-[var(--text)] transition-colors"
            >
              <i className={`fas ${visible ? 'fa-eye-slash' : 'fa-eye'} text-sm`} />
            </button>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <i className="fas fa-circle-exclamation text-[10px]" />{error}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';
