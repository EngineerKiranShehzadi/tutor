'use client';
import { useEffect, useState } from 'react';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnToolbar, filterSelect } from '@/components/admin/buttons';
import { PhoenixConnectionIndicator } from './PhoenixConnectionState';
import { observabilityApi } from '@/lib/observability-api';
import type { ObservabilityStatus } from '@/types/observability';

export type AutoRefreshInterval = 0 | 10000 | 30000 | 60000;

interface ObservabilityHeaderProps {
  /** This tab's own name. Every tab used to be headed "RAG Observability",
      so the largest words on screen never said which of the six you were
      looking at and only the tab strip did. */
  title: string;
  subtitle: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  autoRefresh?: AutoRefreshInterval;
  onAutoRefreshChange?: (v: AutoRefreshInterval) => void;
  lastRefreshedAt?: Date | null;
}

export function ObservabilityHeader({ title, subtitle, onRefresh, refreshing, autoRefresh, onAutoRefreshChange, lastRefreshedAt }: ObservabilityHeaderProps) {
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
      iconGradient=" "
      title={title}
      subtitle={subtitle}
      parent={{ label: 'Observability', href: '/admin/rag-traces' }}
      action={
        <div className="flex items-center gap-3">
          <PhoenixConnectionIndicator status={status} loading={statusLoading} />
          {lastRefreshedAt && (
            <span className="text-caption text-[var(--muted2)]">Updated {lastRefreshedAt.toLocaleTimeString()}</span>
          )}
          {/* The same on/off rule the filter bars use: Auto-refresh is
              neutral while it is off and tinted once it is running, so the
              colour means something is on rather than decorating the strip.
              Refresh holds no state, so it stays neutral always. */}
          {onAutoRefreshChange && (
            <select
              value={autoRefresh ?? 0}
              onChange={(e) => onAutoRefreshChange(Number(e.target.value) as AutoRefreshInterval)}
              className={filterSelect((autoRefresh ?? 0) !== 0)}
              aria-label="Auto-refresh interval"
            >
              <option value={0}>Auto-refresh: Off</option>
              <option value={10000}>Every 10s</option>
              <option value={30000}>Every 30s</option>
              <option value={60000}>Every 1m</option>
            </select>
          )}
          {onRefresh && (
            <button onClick={onRefresh} disabled={refreshing} className={btnToolbar}>
              <i className={`fas fa-rotate mr-1.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
            </button>
          )}
        </div>
      }
    />
  );
}
