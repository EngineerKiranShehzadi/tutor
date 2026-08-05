'use client';
import { useEffect, useState } from 'react';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { PhoenixConnectionIndicator } from './PhoenixConnectionState';
import { observabilityApi } from '@/lib/observability-api';
import type { ObservabilityStatus } from '@/types/observability';

export type AutoRefreshInterval = 0 | 10000 | 30000 | 60000;

interface ObservabilityHeaderProps {
  subtitle: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  autoRefresh?: AutoRefreshInterval;
  onAutoRefreshChange?: (v: AutoRefreshInterval) => void;
  lastRefreshedAt?: Date | null;
}

export function ObservabilityHeader({ subtitle, onRefresh, refreshing, autoRefresh, onAutoRefreshChange, lastRefreshedAt }: ObservabilityHeaderProps) {
  const [status, setStatus] = useState<ObservabilityStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    observabilityApi.getStatus(controller.signal)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setStatusLoading(false));
    return () => controller.abort();
  }, []);

  return (
    <AdminPageHero
      icon="fas fa-timeline"
      iconGradient="from-purple-500 to-fuchsia-600"
      title="RAG Observability"
      subtitle={subtitle}
      action={
        <div className="flex items-center gap-3">
          <PhoenixConnectionIndicator status={status} loading={statusLoading} />
          {lastRefreshedAt && (
            <span className="text-[12px] text-white/50">Updated {lastRefreshedAt.toLocaleTimeString()}</span>
          )}
          {onAutoRefreshChange && (
            <select
              value={autoRefresh ?? 0}
              onChange={(e) => onAutoRefreshChange(Number(e.target.value) as AutoRefreshInterval)}
              className="text-[12px] font-semibold bg-white/10 text-white border border-white/20 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-white/30"
              aria-label="Auto-refresh interval"
            >
              <option value={0} className="text-slate-900">Auto-refresh: Off</option>
              <option value={10000} className="text-slate-900">Every 10s</option>
              <option value={30000} className="text-slate-900">Every 30s</option>
              <option value={60000} className="text-slate-900">Every 1m</option>
            </select>
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="text-[13px] font-semibold bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-lg px-3.5 py-2 transition-colors disabled:opacity-50"
            >
              <i className={`fas fa-rotate-right mr-1.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          )}
        </div>
      }
    />
  );
}
