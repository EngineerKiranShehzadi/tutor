'use client';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { monitorApi, type MonitorTimeseries, type MonitorWindow } from './monitor-api';
import { SectionCard } from './SectionCard';
import { useMonitorData } from './useMonitorData';

/**
 * Are students using the tutor, and when.
 *
 * Two mistakes came before this. It was a line chart, which claims the space
 * between two points means something — true of a temperature, false of a
 * tally of questions, and over a week of hourly buckets it drew the shape of
 * a heart monitor. Then it was three stacked series in navy and gold: a
 * colour pair that fights, a legend above every chart, and a third telling
 * of what the figures above and the failure list below already say.
 *
 * One question, one series, one colour. How many questions came in, per day.
 * Which lectures could not answer them is Content Gaps; what failed is the
 * list under this one.
 */

interface Bucket { bucket: string; answered: number; notFound: number; errors: number; total: number }

// Buckets arrive as UTC ISO strings; everything shown is local time.
function tickLabel(bucket: string, size: 'hour' | 'day') {
  const d = new Date(bucket);
  return size === 'day'
    ? d.toLocaleDateString([], { day: 'numeric', month: 'short' })
    : d.toLocaleTimeString([], { hour: '2-digit', hour12: false }) + ':00';
}
function fullLabel(bucket: string, size: 'hour' | 'day') {
  const d = new Date(bucket);
  return size === 'day'
    ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long' })
    : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/**
 * A day with no questions has nothing to say, and the default tooltip said
 * it three times over on every empty day the mouse crossed.
 */
function BucketTooltip({ active, payload, size }: {
  active?: boolean; payload?: { payload: Bucket }[]; size: 'hour' | 'day';
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  if (b.total === 0) return null;
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-card px-3 py-2 text-caption shadow-[0_4px_16px_rgba(22,26,31,0.10)]">
      <p className="font-semibold text-[var(--text)]">{fullLabel(b.bucket, size)}</p>
      <p className="text-[var(--muted)] mt-0.5">
        <span className="font-semibold text-[var(--text)] tabular-nums">{b.total.toLocaleString()}</span>
        {b.total === 1 ? ' question' : ' questions'}
      </p>
      {b.notFound > 0 && (
        <p className="text-[var(--muted)]">{b.notFound.toLocaleString()} not in the uploaded material</p>
      )}
    </div>
  );
}

export function TrendChart({ windowKey, tick }: { windowKey: MonitorWindow; tick: number }) {
  const { data, loading, error, reload } = useMonitorData<MonitorTimeseries>((s) => monitorApi.getTimeseries(windowKey, s), windowKey, tick);
  const size = data?.bucketSize ?? 'day';
  const buckets: Bucket[] = (data?.buckets ?? []).map((b) => ({
    ...b, total: b.answered + b.notFound + b.errors,
  }));
  const hasActivity = buckets.some((b) => b.total > 0);
  const axis = { fontSize: 11, fill: '#8e8e92' };

  return (
    <SectionCard
      title="Questions over time"
      subtitle={size === 'day'
        ? 'How many questions students asked each day. Use it to see whether the tutor is being used, and when.'
        : 'How many questions students asked each hour. Use it to see whether the tutor is being used, and when.'}
      loading={loading}
      error={error}
      hasData={!!data}
      empty={!!data && !hasActivity}
      emptyText="No questions were asked in this period"
      emptyIcon="fas fa-chart-column"
      onRetry={reload}
      skeleton={<div className="h-[240px] rounded-card bg-[var(--surface)] animate-pulse" aria-hidden="true" />}
    >
      <div className="h-[275px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e5e3df" vertical={false} />
            {/* Named, because "15:00 17:00 19:00" and "Nov 6 Nov 7" are not
                the same kind of thing and the chart switches between them
                depending on the period. */}
            <XAxis
              dataKey="bucket"
              tickFormatter={(v: string) => tickLabel(v, size)}
              tick={axis}
              tickLine={false}
              axisLine={{ stroke: '#e5e3df' }}
              minTickGap={16}
              height={54}
              label={{ value: size === 'day' ? 'Date' : 'Time of day', position: 'insideBottom', offset: 6, style: { fontSize: 11, fill: '#8e8e92' } }}
            />
            {/* Labelled, because a bare column of numbers down the side of a
                chart does not say what it counts. 40px so a four-figure day
                is not rendered as "000". */}
            <YAxis
              allowDecimals={false}
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={52}
              label={{ value: 'Questions', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#8e8e92', textAnchor: 'middle' } }}
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v))}
            />
            {/* No cursor highlight. Any fill behind the hovered bar reads as
                a second, paler bar standing next to the real one; the tooltip
                already says which day you are on. */}
            <Tooltip cursor={false} content={<BucketTooltip size={size} />} />
            <Bar dataKey="total" name="Questions" fill="#1f3a5f" maxBarSize={40} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
