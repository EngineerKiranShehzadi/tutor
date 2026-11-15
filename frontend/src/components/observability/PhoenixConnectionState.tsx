'use client';
import type { ObservabilityStatus } from '@/types/observability';

export function PhoenixConnectionIndicator({ status, loading }: { status: ObservabilityStatus | null; loading: boolean }) {
  if (loading) {
    return <span className="inline-flex items-center gap-1.5 text-caption text-[var(--muted2)]"><span className="w-2 h-2 rounded-full bg-[var(--border)] animate-pulse" />Checking…</span>;
  }
  if (!status) return null;

  if (!status.observabilityEnabled || !status.phoenixEnabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-[var(--muted)]">
        <span className="w-2 h-2 rounded-full bg-[var(--muted2)]" /> Phoenix disabled
      </span>
    );
  }
  if (!status.phoenixReachable) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-[var(--gold)]">
        <span className="w-2 h-2 rounded-full bg-[var(--gold)]" /> Phoenix unreachable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-[var(--accent)]">
      <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" /> Connected · {status.endpointLabel}
    </span>
  );
}

// Full-page-section state for when Phoenix is disabled/unreachable and a
// tab has no data to show at all — distinct from a normal "no results yet"
// empty state (see EmptyState below) so admins can tell the difference
// between "off" and "on but nothing happened yet".
export function PhoenixUnavailablePanel({ status }: { status: ObservabilityStatus | null }) {
  // Only "turned off" when the status actually says so. `!status?.x` is
  // true when status is null, so a status that could not be read was being
  // reported as a deliberate setting, telling the reader to go and change
  // two env vars that were already correct.
  const disabled = status !== null && (!status.observabilityEnabled || !status.phoenixEnabled);
  return (
    <div className="bg-[var(--card)] rounded-card border border-[var(--border)] py-16 flex flex-col items-center justify-center text-center px-8">
      <div className="w-16 h-16 rounded-card bg-[var(--surface)] flex items-center justify-center mb-4">
        <i className={`fas ${disabled ? 'fa-power-off' : 'fa-plug-circle-xmark'} text-h1 text-[var(--muted2)]`} />
      </div>
      <p className="text-label font-semibold text-[var(--text)]">{disabled ? 'Tracing is turned off' : 'Phoenix cannot be reached'}</p>
      <p className="text-caption text-[var(--muted2)] mt-1 max-w-md">
        {disabled
          ? 'Set OBSERVABILITY_ENABLED=true and PHOENIX_ENABLED=true in the backend .env, then restart the server.'
          : `Could not reach the Phoenix server at ${status?.endpointLabel ?? 'the configured address'}. Check that it is running and that PHOENIX_BASE_URL is correct.`}
      </p>
      {/* What still works. This used to say every tab needs Phoenix, which
          stopped being true once the counts, the trace list, the sessions and
          the errors moved onto the request log. Only the step-by-step detail
          needs Phoenix now. */}
      <p className="text-caption text-[var(--muted2)] mt-3 max-w-md">
        Only the step-by-step breakdown of a request needs Phoenix. The counts, the request list, the
        sessions and the failures are read from the database, and Tutor Health does not use Phoenix at all.
      </p>
      {status?.recentErrorMessage && (
        <p className="text-caption text-[var(--gold)] mt-3 font-mono bg-[var(--gold-soft)] rounded-control px-3 py-2">{status.recentErrorMessage}</p>
      )}
    </div>
  );
}

// `icon` is optional: an empty panel reads better as two lines of plain text
// than as a large decorative glyph sitting in a tinted tile.
export function EmptyState({ icon, title, message }: { icon?: string; title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-8">
      {icon && (
        <div className="w-16 h-16 rounded-card bg-[var(--surface)] flex items-center justify-center mb-4">
          <i className={`fas ${icon} text-h1 text-[var(--muted2)]`} aria-hidden="true" />
        </div>
      )}
      <p className="text-label font-semibold text-[var(--muted)]">{title}</p>
      <p className="text-caption text-[var(--muted2)] mt-1 max-w-sm">{message}</p>
    </div>
  );
}

const PHOENIX_FAILURE = /phoenix|observability/i;

/**
 * The request is in the log, its trace is not in Phoenix.
 *
 * The two stores keep different amounts of history. The trace list reads
 * rag_request_log, which holds every request since the project started;
 * the step-by-step view reads Phoenix, which holds only what is still in its
 * own database. So a row can open onto a trace that is no longer there, and
 * that is not a fault: it is one store reaching further back than the other.
 * Announcing it as "Something went wrong" over a Retry button that can never
 * succeed was the same mistake the Phoenix branch above exists to fix.
 */
const TRACE_EXPIRED = /no spans found for trace/i;

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  /**
   * Phoenix being off is a setting, not a fault.
   *
   * Spans and Errors sent every failure through here, so a server that was
   * deliberately switched off was announced as "Something went wrong" with a
   * Retry button that could never succeed. Sessions already told the truth;
   * now every tab does, without each one having to decide.
   */
  if (PHOENIX_FAILURE.test(message)) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-8">
        <div className="w-16 h-16 rounded-card bg-[var(--surface)] flex items-center justify-center mb-4">
          <i className="fas fa-plug-circle-xmark text-h1 text-[var(--muted2)]" aria-hidden="true" />
        </div>
        <p className="text-label font-semibold text-[var(--text)]">Tracing is not available</p>
        <p className="text-caption text-[var(--muted2)] mt-1 max-w-md">{message}</p>
        <p className="text-caption text-[var(--muted2)] mt-3 max-w-md">
          Every tab in this section reads from Phoenix, so all of them are empty until it is running. Tutor
          Health does not: it reads the request log in the database, and keeps working either way.
        </p>
      </div>
    );
  }

  if (TRACE_EXPIRED.test(message)) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-8">
        <p className="text-label font-semibold text-[var(--text)]">The step-by-step view is no longer available</p>
        <p className="text-caption text-[var(--muted2)] mt-1 max-w-md">
          This request is still recorded, which is why it appears in the list, but Phoenix no longer holds
          its trace. Phoenix keeps a shorter history than the request log, so older requests can be listed
          without the detail behind them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-8">
      <div className="w-16 h-16 rounded-card bg-[var(--gold-soft)] flex items-center justify-center mb-4">
        <i className="fas fa-triangle-exclamation text-h1 text-[var(--gold)]" />
      </div>
      <p className="text-label font-semibold text-[var(--text)]">Something went wrong</p>
      <p className="text-caption text-[var(--muted2)] mt-1 max-w-sm">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 text-caption font-semibold text-[var(--accent)] hover:text-[var(--accent-deep)] px-4 py-2 rounded-control border border-[var(--border)] hover:bg-[var(--accent-soft)] transition-colors">
          <i className="fas fa-rotate-right mr-1.5" /> Retry
        </button>
      )}
    </div>
  );
}
