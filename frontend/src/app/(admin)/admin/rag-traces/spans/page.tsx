'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { CursorPagination } from '@/components/observability/Pagination';
import { EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { ObservabilitySpan } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

const SPAN_KINDS = ['LLM', 'RETRIEVER', 'RERANKER', 'EMBEDDING', 'CHAIN'];

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
    <div className="max-w-[1500px]">
      <ObservabilityHeader subtitle="Cross-trace span investigation — find every slow, failed, or model-specific operation across requests." />
      <ObservabilityTabs />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-5 flex flex-wrap items-center gap-3">
        <select value={spanKind} onChange={(e) => updateFilter('spanKind', e.target.value)} className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5">
          <option value="">All kinds</option>
          {SPAN_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input value={name} onChange={(e) => updateFilter('name', e.target.value)} placeholder="Span name (e.g. rerank-candidates)" className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 flex-1 min-w-[200px]" />
        <select value={status} onChange={(e) => updateFilter('status', e.target.value)} className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5">
          <option value="">All statuses</option>
          <option value="OK">OK</option>
          <option value="ERROR">Error</option>
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {error ? <ErrorState message={error} onRetry={() => load(cursor)} />
          : loading ? <div className="p-6 space-y-3">{[1, 2, 3, 4, 5].map(i => <div key={i} className="h-9 bg-slate-100 rounded-lg animate-pulse" />)}</div>
          : spans.length === 0 ? <EmptyState icon="fa-layer-group" title="No spans match these filters" message="Try a different span kind or clear the filters." />
          : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80">
                      <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Time</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Span</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Kind</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Status</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Duration</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Model</th>
                      <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Trace</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {spans.map(s => (
                      <tr key={s.spanId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(s.traceId)}?span=${encodeURIComponent(s.spanId)}`)} className="hover:bg-slate-50/60 cursor-pointer transition-colors">
                        <td className="px-5 py-3 text-[12px] text-slate-500 whitespace-nowrap">{new Date(s.startTime).toLocaleTimeString()}</td>
                        <td className="px-4 py-3 text-[13px] font-medium text-slate-700">{s.name}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-500">{s.kind}</td>
                        <td className="px-4 py-3"><TraceStatusBadge status={s.status} /></td>
                        <td className="px-4 py-3 text-[13px] text-slate-500 tabular-nums">{fmtMs(s.durationMs)}</td>
                        <td className="px-4 py-3 text-[12px] text-slate-500">{s.model ?? '—'}</td>
                        <td className="px-4 py-3 text-[11px] text-slate-400 font-mono truncate max-w-[140px]">{s.traceId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${spans.length} span${spans.length !== 1 ? 's' : ''} on this page`} />
            </>
          )}
      </div>
    </div>
  );
}
