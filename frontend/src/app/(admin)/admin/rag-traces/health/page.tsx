'use client';
// Corrections still land here; new monitoring features go to /admin/monitor.
// This tab is the per dependency detail behind Tutor Health's one line verdict,
// and it takes that verdict from the same function Tutor Health uses so the two
// pages cannot describe one payload differently.
import { useCallback, useEffect, useState } from 'react';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { ErrorState } from '@/components/observability/PhoenixConnectionState';
import { describeHealth } from '@/components/monitor/StatusBanner';
import { monitorApi, type ReadinessResult, type ComponentStatus, type HealthHistory } from '@/components/monitor/monitor-api';
import { observabilityApi } from '@/lib/observability-api';
import { componentLabel, errorCodeLabel } from '@/lib/monitor-labels';
import { fmtDateTime } from '@/lib/chart-format';
import { fieldLabel } from '@/lib/ui';
import type { ObservabilityStatus, PhoenixCapabilities } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

// The order health.service.ts checks them in (requiredComponents). Any
// component the backend adds later is appended rather than silently dropped.
const ORDER = ['database', 'pgvector', 'embeddingServer', 'reranker', 'answerLlm'];

// "degraded" from this endpoint means the check could not be run, not that
// something is wrong, so it reads as neutral. Down is the only state that gets
// the gold the rest of the admin warns with: the two used to be drawn
// identically, so a service that was unreachable looked like one that was
// simply never probed.
const STATUS: Record<ComponentStatus, { label: string; text: string }> = {
  healthy:   { label: 'Working',     text: 'text-[var(--text)]' },
  degraded:  { label: 'Not checked', text: 'text-[var(--muted)]' },
  unhealthy: { label: 'Down',        text: 'text-[var(--gold)] font-semibold' },
};

const VERDICT_DOT: Record<string, string> = {
  ok: 'bg-[var(--accent)]',
  warn: 'bg-[var(--gold)]',
  down: 'bg-[var(--gold)]',
  unknown: 'bg-[var(--muted2)]',
};

// latencyMs is 0 on every failure, and 0 for a provider that is configured but
// has no probe to time. Printing that as "0ms" claimed a response time for
// something that never responded, so only a measured value is shown.
function measuredLatency(c: { status: ComponentStatus; latencyMs: number }): string {
  return c.status === 'healthy' && c.latencyMs > 0 ? fmtMs(c.latencyMs) : '—';
}

/**
 * Uptime, with the number of checks it is based on.
 *
 * "100%" on its own is the most misleading thing this page could print: right
 * after a restart it is one check, and it would sit in the same column as a
 * figure built from 288. The count is stated beside it for the same reason the
 * Overview says when a figure is sampled.
 */
function uptimeCell(h: { uptime: number | null; sampleCount: number } | undefined) {
  if (!h || h.sampleCount === 0) return { text: '—', note: 'No checks recorded yet' };
  const pct = (h.uptime ?? 0) * 100;
  // One decimal only below 100, so a perfect record reads "100%" rather than
  // "100.0%", and a single failure in 288 does not round away to 100%.
  return {
    text: pct === 100 ? '100%' : `${pct.toFixed(1)}%`,
    note: `${h.sampleCount} check${h.sampleCount === 1 ? '' : 's'}`,
  };
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={fieldLabel}>{label}</span>
      <span className="text-caption text-[var(--text)]">{value}</span>
    </div>
  );
}

export default function SystemHealthPage() {
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [history, setHistory] = useState<HealthHistory | null>(null);
  const [obsStatus, setObsStatus] = useState<ObservabilityStatus | null>(null);
  const [caps, setCaps] = useState<PhoenixCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  // Round trip of the readiness request, measured in the browser. Labelled as
  // a round trip, not as a "Backend" probe: it is not comparable with the
  // server measured times in the table, and the backend returning a body at
  // all is already proof that it is up.
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const startedAt = performance.now();
    const [r, s, c, h] = await Promise.allSettled([
      monitorApi.getReadiness(),
      observabilityApi.getStatus(),
      observabilityApi.getCapabilities(),
      monitorApi.getHealthHistory(24),
    ]);
    if (r.status === 'fulfilled') {
      setReadiness(r.value);
      setReadinessError(null);
      setRoundTripMs(Math.round(performance.now() - startedAt));
    } else {
      // The request itself did not come back. That is a different thing from a
      // dependency being down, which arrives as a 503 carrying the full body,
      // and it used to be drawn as a grid of "unknown" with nothing said.
      setReadiness(null);
      setRoundTripMs(null);
      setReadinessError(r.reason instanceof Error ? r.reason.message : 'The health check did not respond.');
    }
    if (s.status === 'fulfilled') setObsStatus(s.value);
    if (c.status === 'fulfilled') setCaps(c.value);
    // History failing is not worth failing the page over: the live check is
    // the point, and the two history columns can say they have nothing.
    setHistory(h.status === 'fulfilled' ? h.value : null);
    setCheckedAt(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const verdict = describeHealth(readiness);
  const components = readiness?.components ?? {};
  const keys = [...ORDER.filter(k => k in components), ...Object.keys(components).filter(k => !ORDER.includes(k))];
  const historyByComponent = new Map((history?.components ?? []).map(h => [h.component, h]));

  const tracingOn = !!(obsStatus?.observabilityEnabled && obsStatus?.phoenixEnabled);
  const phoenixState = !obsStatus
    ? 'Unknown'
    : !tracingOn
      ? 'Turned off'
      : obsStatus.phoenixReachable
        ? `Connected to ${obsStatus.endpointLabel}`
        : 'Not reachable';

  return (
    <div className="max-w-[1180px]">
      <ObservabilityHeader
        title="System Health"
        subtitle="Every service the tutor depends on: whether it is working, how fast it responds, and how reliable it has been."
        onRefresh={load}
        refreshing={loading}
        lastRefreshedAt={checkedAt}
      />
      <ObservabilityTabs />

      {loading && !readiness && !readinessError ? (
        <>
          <div className="h-5 w-72 rounded bg-[var(--surface)] animate-pulse mb-6" aria-hidden="true" />
          <div className="h-64 rounded-card bg-[var(--surface)] animate-pulse" aria-hidden="true" />
        </>
      ) : readinessError ? (
        <ErrorState message={readinessError} onRetry={load} />
      ) : (
        <>
          {/* The verdict is a line of text, not a full width box holding three
              words. Same shape as Tutor Health, and the same source. */}
          <p role="status" className="flex items-center gap-2.5 text-label mb-6">
            <span className={`w-2 h-2 rounded-full shrink-0 ${VERDICT_DOT[verdict.level]}`} aria-hidden="true" />
            <span className={verdict.level === 'ok' || verdict.level === 'unknown' ? 'text-[var(--text)]' : 'font-semibold text-[var(--gold)]'}>
              {verdict.text}
            </span>
            {readiness && (
              <span className="text-caption text-[var(--muted2)]">· checked {fmtDateTime(readiness.checkedAt)}</span>
            )}
            {roundTripMs !== null && (
              <span className="text-caption text-[var(--muted2)]" title="Time for this page's health request to come back, measured in the browser. Not a server side probe.">
                · round trip {fmtMs(roundTripMs)}
              </span>
            )}
          </p>

          <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden mb-6">
            <table className="w-full">
              <thead><tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Response time</th>
                <th className="px-4 py-3 font-medium">Uptime (24h)</th>
                <th className="px-4 py-3 font-medium">Last failure</th>
              </tr></thead>
              <tbody className="divide-y divide-[var(--border)]">
                {keys.map(key => {
                  const c = components[key];
                  const s = STATUS[c.status];
                  const up = uptimeCell(historyByComponent.get(key));
                  const lastFailure = historyByComponent.get(key)?.lastFailureAt ?? null;
                  return (
                    <tr key={key}>
                      {/* componentLabel is the same map Tutor Health reads, so
                          the five services are named identically on both. */}
                      <td className="px-5 py-3 text-caption text-[var(--text)]">{componentLabel(key)}</td>
                      {/* No dot. The word already says the state, and five of
                          them stacked down the column read as a bullet list
                          rather than as data. The one dot on the page is the
                          verdict line, where it means something. */}
                      {/* The reason sits under the state it explains. It was a
                          column of its own, which meant a sixth column that
                          was empty whenever nothing was wrong, and a reason
                          three columns away from the "Down" it belonged to. */}
                      <td className="px-4 py-3">
                        <span className={`text-caption ${s.text}`}>{s.label}</span>
                        {c.errorCode && (
                          <span className="block text-caption text-[var(--muted)]">{errorCodeLabel(c.errorCode)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-caption text-[var(--text)] tabular-nums">{measuredLatency(c)}</td>
                      <td className="px-4 py-3 text-caption text-[var(--text)] tabular-nums">
                        {up.text}
                        <span className="text-[var(--muted2)]"> · {up.note}</span>
                      </td>
                      {/* Across all retained history, not just the window: a
                          service that last failed four days ago is the answer,
                          and a 24 hour window would have shown nothing. */}
                      <td className="px-4 py-3 text-caption text-[var(--muted)]">
                        {lastFailure ? fmtDateTime(lastFailure) : 'None recorded'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* health.service.ts caches each probe (HEALTH_CHECK_CACHE_TTL_MS),
              but checkedAt is regenerated on every request, so two refreshes a
              second apart showed a new time against identical numbers. The
              cache is right: without it, refreshing this page would call
              OpenAI and Voyage every time. Only the implication was wrong. No
              number here, so it stays true if the setting changes. */}
          {readiness && (
            <p className="text-caption text-[var(--muted2)] -mt-4 mb-6">
              Response time is a live check, cached briefly on the server, so a refresh may repeat the previous
              measurement rather than probing again. Uptime and last failure come from the recorded history,
              sampled every few minutes.
            </p>
          )}

          {/* Tracing is one subject, so it is one list. It used to be four
              cards, and two of them only restated the same pair of env flags
              the Phoenix card already checked. */}
          <p className="text-caption font-semibold text-[var(--muted2)] mb-3">Tracing</p>
          <div className="grid grid-cols-2 gap-x-10 gap-y-2 mb-4">
            {/* Not labelled "Tracing": it sat directly under the heading of
                the same name, so the word appeared twice in two lines. */}
            <Detail label="Collection" value={tracingOn ? 'On' : 'Off'} />
            <Detail label="Phoenix" value={phoenixState} />
            <Detail label="Phoenix version" value={caps?.serverVersion ?? 'Unknown'} />
            <Detail label="Project" value={obsStatus?.projectName ?? '—'} />
            <Detail label="Sampling" value={obsStatus ? `${(obsStatus.samplingRate * 100).toFixed(0)}%` : '—'} />
            <Detail label="Content capture" value={obsStatus?.contentCaptureEnabled ? 'On' : 'Off'} />
          </div>

          {tracingOn && obsStatus && !obsStatus.phoenixReachable && (
            <p className="text-caption text-[var(--muted)]">
              Phoenix is not answering, so the step by step view of a request is unavailable. Students are
              unaffected: tracing sits outside the tutoring path, and the services above are checked separately.
            </p>
          )}
          {/* Shown only while Phoenix is unreachable, as the specific reason
              under the sentence that states the situation in words. It used to
              print raw in gold mono whatever the state was, so a recovered
              Phoenix still displayed the failure it had already come back from:
              the backend clears lastRecentError on a successful DATA query, and
              this page only calls /status and /capabilities, so the message
              never got cleared here at all. That is fixed in the route, which
              now clears it on any successful reachability probe. */}
          {obsStatus?.recentErrorMessage && !obsStatus.phoenixReachable && (
            <p className="text-caption text-[var(--muted)] mt-1">
              <span className={fieldLabel}>Reported error</span> {obsStatus.recentErrorMessage}
            </p>
          )}
        </>
      )}
    </div>
  );
}
