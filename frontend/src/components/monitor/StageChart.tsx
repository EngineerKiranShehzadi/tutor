'use client';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { monitorApi, type MonitorWindow, type StageStats } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';
import { stageLabel } from '@/lib/monitor-labels';

const MAX_STAGES = 10;
const ROW_H = 34;
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

interface Point { name: string; p95Ms: number; p50Ms: number }

function StageTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-[12px]">
      <p className="font-semibold text-slate-800 mb-1">{p.name}</p>
      <p className="text-slate-600">Slowest 1 in 20 (p95): <span className="font-semibold">{fmtMs(p.p95Ms)}</span></p>
      <p className="text-slate-600">Typical (p50): <span className="font-semibold">{fmtMs(p.p50Ms)}</span></p>
    </div>
  );
}

export function StageChart({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<StageStats[]>((s) => monitorApi.getStages(windowKey, s), windowKey, tick);
  const points: Point[] = [...(data ?? [])]
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, MAX_STAGES)
    .map((s) => ({ name: stageLabel(s.stage), p95Ms: s.p95Ms, p50Ms: s.p50Ms }));
  const axis = { fontSize: 11, fill: '#64748b' };

  return (
    <SectionCard
      title="Slowest pipeline steps"
      subtitle="How long each step takes. p95 means 19 out of 20 answers were faster."
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && points.length === 0}
      emptyText="No step timings were recorded in this period"
      emptyIcon="fas fa-stopwatch"
      onRetry={reload}
    >
      <div style={{ height: points.length * ROW_H + 30 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#f1f5f9" horizontal={false} />
            <XAxis type="number" tick={axis} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} tickFormatter={(v: number) => fmtMs(v)} />
            <YAxis type="category" dataKey="name" width={140} tick={axis} tickLine={false} axisLine={false} interval={0} />
            <Tooltip content={<StageTooltip />} cursor={{ fill: '#f8fafc' }} />
            <Bar dataKey="p95Ms" name="p95" fill="#7c3aed" radius={[0, 6, 6, 0]} barSize={16} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
