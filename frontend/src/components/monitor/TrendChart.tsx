'use client';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { monitorApi, type MonitorTimeseries, type MonitorWindow } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';

const SERIES = [
  { key: 'answered', name: 'Answered', color: '#059669' },
  { key: 'notFound', name: 'Not found in lecture', color: '#d97706' },
  { key: 'errors', name: 'Errors', color: '#dc2626' },
] as const;

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

// Buckets arrive as UTC ISO strings; everything shown is local time.
function tickLabel(bucket: string, size: 'hour' | 'day') {
  const d = new Date(bucket);
  return size === 'day'
    ? d.toLocaleDateString([], { day: 'numeric', month: 'short' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fullLabel(bucket: string, size: 'hour' | 'day') {
  const d = new Date(bucket);
  return size === 'day'
    ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

const tooltipStyle = { borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 };

function ChartSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-[260px] rounded-xl bg-slate-100 animate-pulse" />
      <div className="h-[110px] rounded-xl bg-slate-100 animate-pulse mt-4" />
    </div>
  );
}

export function TrendChart({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<MonitorTimeseries>((s) => monitorApi.getTimeseries(windowKey, s), windowKey, tick);
  const buckets = data?.buckets ?? [];
  const size = data?.bucketSize ?? 'hour';
  const hasActivity = buckets.some((b) => b.answered + b.notFound + b.errors > 0);
  const axis = { fontSize: 11, fill: '#94a3b8' };
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };

  return (
    <SectionCard
      title="Questions over time"
      subtitle={size === 'day' ? 'Per day, local time' : 'Per hour, local time'}
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && !hasActivity}
      emptyText="No questions were asked in this period"
      emptyIcon="fas fa-chart-line"
      onRetry={reload}
      skeleton={<ChartSkeleton />}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[12px] text-slate-500">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />{s.name}
          </span>
        ))}
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={buckets} margin={margin}>
            <CartesianGrid stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="bucket" tickFormatter={(v: string) => tickLabel(v, size)} tick={axis} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} minTickGap={24} />
            <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} width={32} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => fullLabel(String(v), size)} />
            {SERIES.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[12px] font-semibold text-slate-500 mt-4 mb-1">Response time (p95)</p>
      <div className="h-[110px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={buckets} margin={margin}>
            <CartesianGrid stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="bucket" tickFormatter={(v: string) => tickLabel(v, size)} tick={axis} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} minTickGap={24} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => fmtMs(v)} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => fullLabel(String(v), size)} formatter={(v) => [fmtMs(Number(v)), 'Response time (p95)']} />
            <Line type="monotone" dataKey="p95Ms" name="Response time (p95)" stroke="#7c3aed" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
