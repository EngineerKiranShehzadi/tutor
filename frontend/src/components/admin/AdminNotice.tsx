'use client';
import { useEffect } from 'react';

/**
 * The one way an admin screen says "that worked" or "that did not".
 *
 * Every page had its own: some stayed on screen until the next navigation,
 * some had no way to dismiss them at all, and the one on Courses cleared
 * itself after four seconds. A message that cannot be dismissed is a message
 * that is still there ten minutes later, next to work it has nothing to do
 * with.
 *
 * So: a success clears itself, because it only confirms what you just did and
 * you are about to look elsewhere. A problem does not, because it is the
 * answer to "why did nothing happen" and must survive being read twice. Both
 * can be closed by hand.
 */
export function AdminNotice({
  kind, message, onDismiss, autoHideMs = 6000,
}: {
  kind: 'success' | 'error';
  message: string;
  onDismiss: () => void;
  /** Success only; a problem stays until it is closed. */
  autoHideMs?: number;
}) {
  useEffect(() => {
    if (kind !== 'success') return;
    const t = setTimeout(onDismiss, autoHideMs);
    return () => clearTimeout(t);
    // `message` is in the list so a second success restarts the clock rather
    // than inheriting what was left of the first one's.
  }, [kind, message, autoHideMs, onDismiss]);

  const problem = kind === 'error';
  return (
    <div
      role={problem ? 'alert' : 'status'}
      className={`mb-5 flex items-start gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] bg-[var(--card)] pl-5 pr-3 py-3.5 ${
        problem ? 'border-l-[var(--gold)]' : 'border-l-[var(--accent)]'}`}
    >
      <i
        className={`fas ${problem ? 'fa-triangle-exclamation text-[var(--gold)]' : 'fa-circle-check text-[var(--accent)]'} text-[13px] mt-1`}
        aria-hidden="true"
      />
      <p className="text-label text-[var(--text)] flex-1">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 -mt-0.5 h-7 w-7 rounded-control text-[var(--muted2)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors"
      >
        <i className="fas fa-xmark text-[13px]" aria-hidden="true" />
      </button>
    </div>
  );
}
