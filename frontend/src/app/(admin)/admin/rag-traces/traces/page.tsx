'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { TraceStatusBadge } from '@/components/observability/TraceStatusBadge';
import { CursorPagination } from '@/components/observability/Pagination';
import { PhoenixUnavailablePanel, EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import type { TraceSummary } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }
function fmtTime(iso: string): string { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

const SORT_OPTIONS = [
  { value: 'start_time:desc', label: 'Newest first' },
  { value: 'start_time:asc', label: 'Oldest first' },
  { value: 'latency_ms:desc', label: 'Slowest first' },
  { value: 'latency_ms:asc', label: 'Fastest first' },
];

export default function TracesExplorerPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters = {
    search: searchParams.get('search') ?? '',
    status: searchParams.get('status') ?? '',
    route: searchParams.get('route') ?? '',
    lectureId: searchParams.get('lectureId') ?? '',
    sessionId: searchParams.get('sessionId') ?? '',
    model: searchParams.get('model') ?? '',
    memoryResult: searchParams.get('memoryResult') ?? '',
    errorOnly: searchParams.get('errorOnly') === 'true',
    sortOrder: searchParams.get('sortOrder') ?? 'start_time:desc',
  };

  const updateFilter = (key: string, value: string | boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === '') params.delete(key); else params.set(key, String(value));
    setCursorStack([null]);
    setPageIndex(0);
    router.replace(`${pathname}?${params.toString()}`);
  };

  const clearFilters = () => { setSearchInput(''); router.replace(pathname); setCursorStack([null]); setPageIndex(0); };

  const load = useCallback(async (cursor: string | null, signal?: AbortSignal) => {
    setLoading(true);
    const [sort, order] = filters.sortOrder.split(':') as ['start_time' | 'latency_ms', 'asc' | 'desc'];
    try {
      const result = await observabilityApi.listTraces({
        cursor, limit: 25, sort, order,
        search: filters.search || undefined,
        status: filters.status || undefined,
        route: filters.route || undefined,
        lectureId: filters.lectureId || undefined,
        sessionId: filters.sessionId || undefined,
        model: filters.model || undefined,
        memoryResult: filters.memoryResult || undefined,
        errorOnly: filters.errorOnly || undefined,
      }, signal);
      setTraces(result.traces);
      setNextCursor(result.nextCursor);
      setError(null);
      setErrorCode(null);
    } catch (err) {
      if (err instanceof ObservabilityApiError) { setError(err.message); setErrorCode(err.code); }
      else if ((err as { code?: string }).code !== 'ERR_CANCELED') setError('Unexpected error loading traces.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    load(cursorStack[pageIndex] ?? null, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pageIndex]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (searchInput !== filters.search) updateFilter('search', searchInput);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const goNext = () => {
    if (!nextCursor) return;
    setCursorStack(s => [...s.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex(i => i + 1);
  };
  const goPrev = () => { if (pageIndex > 0) setPageIndex(i => i - 1); };

  const unavailable = errorCode === 'PHOENIX_DISABLED' || errorCode === 'PHOENIX_UNREACHABLE';
  const activeFilterCount = [filters.status, filters.route, filters.lectureId, filters.sessionId, filters.model, filters.memoryResult, filters.errorOnly ? '1' : ''].filter(Boolean).length;

  return (
    <div className="max-w-[1500px]">
      <ObservabilityHeader subtitle="Filter, search, and inspect individual RAG requests." />
      <ObservabilityTabs />

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300 text-[13px]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search question, answer, trace ID…"
            className="w-full pl-9 pr-3 py-2.5 text-[13px] rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
          />
        </div>
        <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)} className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">All statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="ERROR">Error</option>
        </select>
        <select value={filters.route} onChange={(e) => updateFilter('route', e.target.value)} title="Applies only to the currently loaded page of traces, not your full trace history — Phoenix doesn't support server-side route filtering yet." className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">All routes (this page)</option>
          <option value="FACT_QUESTION">Fact question</option>
          <option value="CONTEXTUAL_FOLLOW_UP">Contextual follow-up</option>
          <option value="LECTURE_SUMMARY">Lecture summary</option>
          <option value="GREETING">Greeting</option>
        </select>
        <select value={filters.memoryResult} onChange={(e) => updateFilter('memoryResult', e.target.value)} title="Applies only to the currently loaded page of traces, not your full trace history — Phoenix doesn't support server-side memory-result filtering yet." className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">Any memory result (this page)</option>
          <option value="EXACT_HIT">Exact hit</option>
          <option value="SEMANTIC_HIT">Semantic hit</option>
          <option value="MISS">Miss</option>
          <option value="NOT_ATTEMPTED">Not attempted</option>
        </select>
        <select value={filters.sortOrder} onChange={(e) => updateFilter('sortOrder', e.target.value)} className="text-[13px] rounded-lg border border-slate-200 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-200">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-[13px] font-medium text-slate-600 px-1">
          <input type="checkbox" checked={filters.errorOnly} onChange={(e) => updateFilter('errorOnly', e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-400" />
          Errors only
        </label>
        {activeFilterCount > 0 && (
          <button onClick={clearFilters} className="text-[13px] font-semibold text-slate-500 hover:text-red-600 transition-colors px-2">
            <i className="fas fa-xmark mr-1" /> Clear ({activeFilterCount})
          </button>
        )}
      </div>

      {(filters.route || filters.memoryResult) && (
        <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-5 -mt-2.5">
          <i className="fas fa-circle-info mr-1.5" />
          Route / memory-result filtering applies only to the page of traces currently loaded, not your full trace history — Phoenix doesn&apos;t support server-side filtering on these fields yet. Widen the time range or page forward to see more matches.
        </p>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {unavailable ? (
          <PhoenixUnavailablePanel status={null} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(cursorStack[pageIndex] ?? null)} />
        ) : loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}
          </div>
        ) : traces.length === 0 ? (
          <EmptyState icon="fa-inbox" title="No traces match these filters" message="Try widening your filters, or ask the tutor a question to generate a new trace." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80">
                    <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Time</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Question</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Route</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Status</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Duration</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Model</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Tokens</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Memory</th>
                    <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Trace ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {traces.map(t => (
                    <tr key={t.traceId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}`)} className="hover:bg-slate-50/60 transition-colors cursor-pointer group">
                      <td className="px-5 py-3.5 text-[12px] text-slate-500 whitespace-nowrap">{fmtTime(t.timestamp)}</td>
                      <td className="px-4 py-3.5 text-[13px] text-slate-700 max-w-[280px] truncate">{t.questionPreview ?? <span className="text-slate-300 italic">Content capture off</span>}</td>
                      <td className="px-4 py-3.5 text-[12px] font-medium text-slate-600">{t.route ?? '—'}</td>
                      <td className="px-4 py-3.5"><TraceStatusBadge status={t.status} /></td>
                      <td className="px-4 py-3.5 text-[13px] text-slate-500 tabular-nums">{fmtMs(t.durationMs)}</td>
                      <td className="px-4 py-3.5 text-[12px] text-slate-500 truncate max-w-[140px]">{t.model ?? '—'}</td>
                      <td className="px-4 py-3.5 text-[12px] text-slate-500 tabular-nums">{t.totalTokens ?? '—'}</td>
                      <td className="px-4 py-3.5 text-[12px] text-slate-500">{t.memoryResult ?? '—'}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-slate-400 font-mono truncate max-w-[120px]">{t.traceId}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(t.traceId); }}
                            className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-indigo-600 transition-all"
                            aria-label="Copy trace ID"
                          >
                            <i className="far fa-copy text-[11px]" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${traces.length} trace${traces.length !== 1 ? 's' : ''} on this page`} />
          </>
        )}
      </div>
    </div>
  );
}
