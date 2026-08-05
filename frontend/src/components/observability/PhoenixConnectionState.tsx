'use client';
import type { ObservabilityStatus } from '@/types/observability';

export function PhoenixConnectionIndicator({ status, loading }: { status: ObservabilityStatus | null; loading: boolean }) {
  if (loading) {
    return <span className="inline-flex items-center gap-1.5 text-[12px] text-slate-400"><span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" />Checking…</span>;
  }
  if (!status) return null;

  if (!status.observabilityEnabled || !status.phoenixEnabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-500">
        <span className="w-2 h-2 rounded-full bg-slate-400" /> Phoenix disabled
      </span>
    );
  }
  if (!status.phoenixReachable) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-600">
        <span className="w-2 h-2 rounded-full bg-red-500" /> Phoenix unreachable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-600">
      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Connected · {status.endpointLabel}
    </span>
  );
}

// Full-page-section state for when Phoenix is disabled/unreachable and a
// tab has no data to show at all — distinct from a normal "no results yet"
// empty state (see EmptyState below) so admins can tell the difference
// between "off" and "on but nothing happened yet".
export function PhoenixUnavailablePanel({ status }: { status: ObservabilityStatus | null }) {
  const disabled = !status?.observabilityEnabled || !status?.phoenixEnabled;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 flex flex-col items-center justify-center text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mb-4">
        <i className={`fas ${disabled ? 'fa-power-off' : 'fa-plug-circle-xmark'} text-2xl text-slate-300`} />
      </div>
      <p className="text-[16px] font-bold text-slate-700">{disabled ? 'Observability is disabled' : 'Phoenix is unreachable'}</p>
      <p className="text-[13px] text-slate-400 mt-1 max-w-md">
        {disabled
          ? 'Set OBSERVABILITY_ENABLED=true and PHOENIX_ENABLED=true in the backend .env, then restart the server.'
          : `Could not reach the Phoenix server at ${status?.endpointLabel ?? 'the configured address'}. Confirm it is running and PHOENIX_BASE_URL is correct.`}
      </p>
      {status?.recentErrorMessage && (
        <p className="text-[12px] text-red-500 mt-3 font-mono bg-red-50 rounded-lg px-3 py-2">{status.recentErrorMessage}</p>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, message }: { icon: string; title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mb-4">
        <i className={`fas ${icon} text-2xl text-slate-300`} />
      </div>
      <p className="text-[15px] font-semibold text-slate-600">{title}</p>
      <p className="text-[13px] text-slate-400 mt-1 max-w-sm">{message}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
        <i className="fas fa-triangle-exclamation text-2xl text-red-400" />
      </div>
      <p className="text-[15px] font-semibold text-slate-700">Something went wrong</p>
      <p className="text-[13px] text-slate-400 mt-1 max-w-sm">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 text-[13px] font-semibold text-indigo-600 hover:text-indigo-700 px-4 py-2 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors">
          <i className="fas fa-rotate-right mr-1.5" /> Retry
        </button>
      )}
    </div>
  );
}
