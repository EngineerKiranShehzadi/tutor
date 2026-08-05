'use client';
import { useCallback, useEffect, useState } from 'react';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { observabilityApi } from '@/lib/observability-api';
import api from '@/lib/api';
import type { ObservabilityStatus, PhoenixCapabilities } from '@/types/observability';

interface ComponentHealth { status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs: number; errorCode?: string }
interface ReadinessResult { status: string; checkedAt: string; components: Record<string, ComponentHealth> }

const STATUS_STYLE: Record<string, { dot: string; text: string; bg: string }> = {
  healthy: { dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  degraded: { dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
  unhealthy: { dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50 border-red-200' },
};

function HealthCard({ name, icon, health, critical }: { name: string; icon: string; health: ComponentHealth | undefined; critical: boolean }) {
  const style = STATUS_STYLE[health?.status ?? 'unhealthy'];
  return (
    <div className={`rounded-2xl border p-5 ${style.bg}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <i className={`fas ${icon} text-slate-500 text-[15px]`} />
          <span className="text-[14px] font-bold text-slate-800">{name}</span>
        </div>
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
      </div>
      <p className={`text-[13px] font-bold uppercase tracking-wide ${style.text}`}>{health?.status ?? 'unknown'}</p>
      <div className="flex items-center justify-between mt-2 text-[12px] text-slate-500">
        <span>{health?.latencyMs !== undefined ? `${health.latencyMs}ms` : '—'}</span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${critical ? 'bg-slate-200 text-slate-600' : 'bg-slate-100 text-slate-400'}`}>{critical ? 'Critical' : 'Non-critical'}</span>
      </div>
      {health?.errorCode && <p className="text-[11px] text-slate-500 font-mono mt-2">{health.errorCode}</p>}
    </div>
  );
}

export default function SystemHealthPage() {
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [obsStatus, setObsStatus] = useState<ObservabilityStatus | null>(null);
  const [caps, setCaps] = useState<PhoenixCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [r, s, c] = await Promise.allSettled([
      api.get<ReadinessResult>('/health/ready'),
      observabilityApi.getStatus(),
      observabilityApi.getCapabilities(),
    ]);
    if (r.status === 'fulfilled') setReadiness(r.value.data);
    if (s.status === 'fulfilled') setObsStatus(s.value);
    if (c.status === 'fulfilled') setCaps(c.value);
    setCheckedAt(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const observabilityDegraded = !obsStatus?.phoenixReachable && obsStatus?.observabilityEnabled;

  return (
    <div className="max-w-[1500px]">
      <ObservabilityHeader subtitle="Backend, database, model services, and Phoenix exporter health." onRefresh={load} refreshing={loading} lastRefreshedAt={checkedAt} />
      <ObservabilityTabs />

      {loading ? (
        <div className="grid grid-cols-4 gap-5">{[1, 2, 3, 4, 5, 6, 7, 8].map(i => <div key={i} className="h-32 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-5 flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${readiness?.status === 'healthy' ? 'bg-emerald-500' : readiness?.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`} />
            <p className="text-[15px] font-bold text-slate-800">Core tutoring path: {readiness?.status ?? 'unknown'}</p>
            <p className="text-[12px] text-slate-400 ml-auto">Checked {readiness ? new Date(readiness.checkedAt).toLocaleTimeString() : '—'}</p>
          </div>

          <p className="text-[12px] font-bold text-slate-400 uppercase tracking-wide mb-3">Core dependencies</p>
          <div className="grid grid-cols-4 gap-5 mb-6">
            <HealthCard name="Backend" icon="fa-server" health={{ status: 'healthy', latencyMs: 0 }} critical />
            <HealthCard name="PostgreSQL" icon="fa-database" health={readiness?.components.database} critical />
            <HealthCard name="Embedding service" icon="fa-vector-square" health={readiness?.components.embeddingServer} critical />
            <HealthCard name="Reranker service" icon="fa-sort" health={readiness?.components.reranker} critical={false} />
            <HealthCard name="Gemini" icon="fa-brain" health={readiness?.components.gemini} critical={false} />
          </div>

          <p className="text-[12px] font-bold text-slate-400 uppercase tracking-wide mb-3">Observability (non-critical to tutoring)</p>
          <div className="grid grid-cols-4 gap-5">
            <HealthCard
              name="Phoenix"
              icon="fa-fire"
              health={{
                status: !obsStatus?.observabilityEnabled || !obsStatus?.phoenixEnabled ? 'degraded' : obsStatus.phoenixReachable ? 'healthy' : 'unhealthy',
                latencyMs: 0,
                errorCode: obsStatus?.recentErrorMessage ?? undefined,
              }}
              critical={false}
            />
            <HealthCard name="Observability exporter" icon="fa-upload" health={{ status: obsStatus?.observabilityEnabled && obsStatus?.phoenixEnabled ? 'healthy' : 'degraded', latencyMs: 0 }} critical={false} />
            <HealthCard name="Trace query API" icon="fa-magnifying-glass" health={{ status: caps?.reachable ? 'healthy' : 'unhealthy', latencyMs: 0 }} critical={false} />
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <p className="text-[13px] font-bold text-slate-800 mb-1">Phoenix server</p>
              <p className="text-[12px] text-slate-500">Version: {caps?.serverVersion ?? 'unknown'}</p>
              <p className="text-[12px] text-slate-500">Project: {obsStatus?.projectName ?? '—'}</p>
              <p className="text-[12px] text-slate-500">Sampling: {obsStatus ? `${(obsStatus.samplingRate * 100).toFixed(0)}%` : '—'}</p>
              <p className="text-[12px] text-slate-500">Content capture: {obsStatus?.contentCaptureEnabled ? 'On' : 'Off'}</p>
            </div>
          </div>

          {observabilityDegraded && (
            <div className="mt-5 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 text-[13px] text-amber-800">
              <i className="fas fa-circle-info mr-2" />
              Observability is degraded (Phoenix unreachable), but this does not affect the student tutoring path — core dependencies above are checked independently.
            </div>
          )}
        </>
      )}
    </div>
  );
}
