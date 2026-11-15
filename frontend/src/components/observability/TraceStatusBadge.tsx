'use client';
import { cn } from '@/lib/cn';

/**
 * The word, and nothing else.
 *
 * This was a tinted, bordered, rounded-full badge with a dot inside it: four
 * pieces of decoration for one word, on every row of every table. The dot
 * went too. A column of two hundred rows reading "Success" does not need two
 * hundred dots to say so, and once only failures carry colour, the eye finds
 * them without anything being drawn for it.
 */

// Sentence case, not the stored SUCCESS / ERROR. A column of shouting codes
// is the shape the data is saved in, not the shape a table should read in.
// An unmapped status still shows its raw value rather than "Unknown".
const LABELS: Record<string, string> = {
  SUCCESS: 'Success', OK: 'Success', ERROR: 'Error',
  FALLBACK: 'Fallback', SKIPPED: 'Skipped', UNSET: 'Not set', UNKNOWN: 'Unknown',
};

export function TraceStatusBadge({ status, className }: { status: string; className?: string }) {
  const key = (status || 'UNKNOWN').toUpperCase();
  const failed = key === 'ERROR' || key === 'FALLBACK';
  return (
    // No size of its own: it inherits the cell it sits in, so Status can
    // never end up a different size from the columns beside it.
    <span className={cn('whitespace-nowrap', failed ? 'font-medium text-[var(--gold)]' : 'text-[var(--text)]', className)}>
      {LABELS[key] ?? status ?? 'Unknown'}
    </span>
  );
}
