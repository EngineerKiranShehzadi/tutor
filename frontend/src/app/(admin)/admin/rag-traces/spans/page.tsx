'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { CursorPagination } from '@/components/observability/Pagination';
import { EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { filterSelect } from '@/components/admin/buttons';
import { fmtDateTime } from '@/lib/chart-format';
import { STAGE_LABELS } from '@/lib/monitor-labels';
import type { ObservabilitySpan } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

const SPAN_KINDS = ['LLM', 'RETRIEVER', 'RERANKER', 'EMBEDDING', 'CHAIN'];

// Phoenix matches a span name exactly, not as a substring, so a typed
// "rerank" returned nothing and the box gave no clue why. The name is picked
// from a list instead of typed.
//
// Not a text input with a <datalist>: a browser draws that list itself,
// positioned against the window and immune to CSS, so it looked nothing like
// the dropdowns beside it. A plain select is the same control as its
// neighbours and obeys the same rules.
const PIPELINE_SPAN_NAMES = Object.keys(STAGE_LABELS);

export default function SpansExplorerPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [spans, setSpans] = useState<ObservabilitySpan[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const spanKind = searchParams.get('spanKind') ?? '';
  const name = searchParams.get('name') ?? '';
  const status = searchParams.get('status') ?? '';

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!value) params.delete(key); else params.set(key, value);
    setCursorStack([null]); setPageIndex(0);
    router.replace(`${pathname}?${params.toString()}`);
  };

  // The known pipeline steps, plus any span name on screen, so names the
  // instrumentation invents for itself (greeting_response_call) can be chosen
  // once they have been seen. The current filter is kept in the list even when
  // its rows are not loaded, so the control never shows a blank selection.
  const nameOptions = useMemo(() => {
    const all = new Set<string>(PIPELINE_SPAN_NAMES);
    spans.forEach(s => all.add(s.name));
    if (name) all.add(name);
    return [...all].sort();
  }, [spans, name]);

  const load = useCallback(async (c: string | null, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await observabilityApi.listSpans({ cursor: c, limit: 50, spanKind: spanKind || undefined, name: name || undefined, status: status || undefined }, signal);
      setSpans(result.spans);
      setNextCursor(result.nextCursor);
      setError(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) setError(err.message);
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') setError('Failed to load spans.');
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spanKind, name, status]);

  useEffect(() => {
    const controller = new AbortController();
    setCursor(cursorStack[pageIndex] ?? null);
    load(cursorStack[pageIndex] ?? null, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, spanKind, name, status]);

  const goNext = () => { if (!nextCursor) return; setCursorStack(s => [...s.slice(0, pageIndex + 1), nextCursor]); setPageIndex(i => i + 1); };
  const goPrev = () => { if (pageIndex > 0) setPageIndex(i => i - 1); };

  return (
    <div className="max-w-[1180px]">
      <ObservabilityHeader title="Spans" subtitle="One operation at a time, across every request: find the slow, failed or model-specific ones." />
      <ObservabilityTabs />

      <div className="mb-5 flex flex-wrap items-center justify-end gap-3">
        <select value={spanKind} onChange={(e) => updateFilter('spanKind', e.target.value)} className={filterSelect(!!spanKind)}>
          <option value="">All kinds</option>
          {SPAN_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={name} onChange={(e) => updateFilter('name', e.target.value)} className={filterSelect(!!name)} aria-label="Span name">
          <option value="">All spans</option>
          {nameOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select value={status} onChange={(e) => updateFilter('status', e.target.value)} className={filterSelect(!!status)}>
          <option value="">All statuses</option>
          <option value="OK">Success</option>
          <option value="ERROR">Error</option>
        </select>
      </div>

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        {error ? <ErrorState message={error} onRetry={() => load(cursor)} />
          : loading ? <div className="p-6 space-y-3">{[1, 2, 3, 4, 5].map(i => <div key={i} className="h-9 bg-[var(--surface)] rounded-control animate-pulse" />)}</div>
          : spans.length === 0 ? <EmptyState title="No spans match these filters" message="Try a different span kind or clear the filters." />
          : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                      <th className="px-5 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Span</th>
                      <th className="px-4 py-3 font-medium">Kind</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 font-medium">Trace</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {spans.map(s => (
                      <tr key={s.spanId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(s.traceId)}?span=${encodeURIComponent(s.spanId)}&from=spans`)} className="hover:bg-[var(--surface)] cursor-pointer transition-colors">
                        <td className="px-5 py-3 text-caption text-[var(--text)] whitespace-nowrap">{fmtDateTime(s.startTime)}</td>
                        <td className="px-4 py-3 text-caption text-[var(--text)]">{s.name}</td>
                        <td className="px-4 py-3 text-caption text-[var(--text)]">{s.kind}</td>
                        <td className="px-4 py-3 text-caption"><TraceStatusBadge status={s.status} /></td>
                        <td className="px-4 py-3 text-caption text-[var(--text)] tabular-nums">{fmtMs(s.durationMs)}</td>
                        <td className="px-4 py-3 text-caption text-[var(--text)]">{s.model ?? '—'}</td>
                        <td className="px-4 py-3 text-[11px] text-[var(--muted2)] font-mono truncate max-w-[140px]">{s.traceId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </div>
      {/* Outside the card: inside it, this had a table row's width,
          padding and top rule, so it read as one more row. */}
      {!error && !loading && spans.length > 0 && (
        <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${spans.length} span${spans.length !== 1 ? 's' : ''} on this page`} />
      )}
    </div>
  );
}
