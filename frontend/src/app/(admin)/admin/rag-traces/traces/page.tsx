'use client';
// Frozen: no new features here; new monitoring work goes to /admin/monitor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ObservabilityHeader } from '@/components/observability/ObservabilityHeader';
import { ObservabilityTabs } from '@/components/observability/ObservabilityTabs';
import { CursorPagination } from '@/components/observability/Pagination';
import { PhoenixUnavailablePanel, EmptyState, ErrorState } from '@/components/observability/PhoenixConnectionState';
import { observabilityApi, ObservabilityApiError } from '@/lib/observability-api';
import { fmtDateTime } from '@/lib/chart-format';
import { filterSelect } from '@/components/admin/buttons';
import { routeLabel, memoryResultLabel, errorCodeLabel } from '@/lib/monitor-labels';
import type { TraceSummary } from '@/types/observability';

function fmtMs(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }

/**
 * What the student actually got, not whether the machine stayed up.
 *
 * This column used to print the raw request status, which is SUCCESS unless
 * something technically failed. A question the lecture could not answer is a
 * SUCCESS: the system retrieved, judged the matches too weak, and said so. So
 * the column read "Success" on roughly 98% of rows and told nobody anything.
 *
 * No new data is needed. fallbackReason is set only when the answer could not
 * be built from the material, which is exactly the distinction worth showing.
 */
function outcomeOf(t: TraceSummary): { text: string; attention: boolean } {
  if (t.status === 'ERROR') return { text: errorCodeLabel(t.errorCode), attention: true };
  if (t.fallbackReason) return { text: 'Not found', attention: true };
  return { text: 'Answered', attention: false };
}

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
  const [scanned, setScanned] = useState<{ count: number; limitReached: boolean }>({ count: 0, limitReached: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Which trace id was just copied, so the button can confirm it. Cleared on
  // a timer, and on unmount so the timer cannot fire into a gone component.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const copyTraceId = useCallback((id: string) => {
    // Older browsers and insecure origins have no clipboard API. Failing
    // silently is fine; claiming "Copied" when nothing was would not be.
    navigator.clipboard?.writeText(id).then(() => {
      setCopiedId(id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 1600);
    }).catch(() => {});
  }, []);

  const filters = {
    search: searchParams.get('search') ?? '',
    status: searchParams.get('status') ?? '',
    route: searchParams.get('route') ?? '',
    lectureId: searchParams.get('lectureId') ?? '',
    sessionId: searchParams.get('sessionId') ?? '',
    model: searchParams.get('model') ?? '',
    memoryResult: searchParams.get('memoryResult') ?? '',
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
      }, signal);
      setTraces(result.traces);
      setNextCursor(result.nextCursor);
      setScanned({ count: result.scannedTraces ?? 0, limitReached: result.scanLimitReached === true });
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
  // The search box counts: leaving it out meant a typed search alone never
  // showed Clear, so the only way to drop it was to empty the box by hand.
  const activeFilterCount = [filters.search, filters.status, filters.route, filters.lectureId, filters.sessionId, filters.model, filters.memoryResult].filter(Boolean).length;
  // lectureId, sessionId and model are sent to the server but have no control
  // of their own, so arriving on a link that carries one showed an active
  // filter with nothing on screen naming it. Each appears as a chip you can
  // remove.
  const linkFilters = [
    { key: 'lectureId', label: 'Lecture', value: filters.lectureId },
    { key: 'sessionId', label: 'Session', value: filters.sessionId },
    { key: 'model', label: 'Model', value: filters.model },
  ].filter(f => f.value);
  const showQuestion = traces.some(t => t.questionPreview);

  return (
    <div className="max-w-[1180px]">
      <ObservabilityHeader title="Traces" subtitle="Every request, filtered and searchable, with the full step-by-step breakdown behind each one." />
      <ObservabilityTabs />

      {/* Filter bar */}
      {/* Right-aligned, so the controls sit over the end of the table
            rather than floating away from everything. */}
      <div className="mb-5 flex flex-wrap items-center justify-end gap-3">
        {/* Sized, not stretched. flex-1 pushed the search box across the whole
            bar and threw the filters against the far right edge, so the row
            read as one control on the left and four stranded on the right.
            Widened since: the row is right-aligned, so this grows leftward
            into empty space without moving the filters. */}
        <div className="relative w-[340px]">
          <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-caption" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search trace ID…"
            className="w-full h-9 pl-9 pr-3 text-caption rounded-control border border-[var(--border)] bg-[var(--card)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)} className={filterSelect(!!filters.status)}>
          <option value="">All statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="ERROR">Error</option>
        </select>
        <select value={filters.route} onChange={(e) => updateFilter('route', e.target.value)} className={filterSelect(!!filters.route)}>
          <option value="">All routes</option>
          <option value="FACT_QUESTION">Fact question</option>
          <option value="CONTEXTUAL_FOLLOW_UP">Contextual follow-up</option>
          <option value="LECTURE_SUMMARY">Lecture summary</option>
          <option value="GREETING">Greeting</option>
        </select>
        <select value={filters.memoryResult} onChange={(e) => updateFilter('memoryResult', e.target.value)} className={filterSelect(!!filters.memoryResult)}>
          <option value="">All memory results</option>
          <option value="EXACT_HIT">Exact hit</option>
          <option value="SEMANTIC_HIT">Semantic hit</option>
          <option value="MISS">Miss</option>
          <option value="NOT_ATTEMPTED">Not attempted</option>
        </select>
        <select value={filters.sortOrder} onChange={(e) => updateFilter('sortOrder', e.target.value)} className={filterSelect(filters.sortOrder !== 'start_time:desc')}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {/* "Errors only" was removed. It did the same job as Status > Error,
            and setting both sent status='SUCCESS' AND status='ERROR', which
            can never match, so the table emptied with nothing to explain it. */}
        {linkFilters.map(f => (
          <span key={f.key} className="h-9 inline-flex items-center gap-2 rounded-control bg-[var(--accent-soft)] px-3 text-caption font-semibold text-[var(--accent)]">
            {f.label}: {f.value}
            <button onClick={() => updateFilter(f.key, '')} aria-label={`Remove the ${f.label.toLowerCase()} filter`} className="hover:text-[var(--accent-deep)]">
              <i className="fas fa-xmark text-[11px]" aria-hidden="true" />
            </button>
          </span>
        ))}
        {activeFilterCount > 0 && (
          <button onClick={clearFilters} className="text-caption font-semibold text-[var(--muted)] hover:text-[var(--text)] transition-colors px-2">
            <i className="fas fa-xmark mr-1" /> Clear ({activeFilterCount})
          </button>
        )}
      </div>

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        {unavailable ? (
          <PhoenixUnavailablePanel status={null} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(cursorStack[pageIndex] ?? null)} />
        ) : loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-10 bg-[var(--surface)] rounded-card animate-pulse" />)}
          </div>
        ) : traces.length === 0 && scanned.limitReached && nextCursor ? (
          <div>
            <EmptyState icon="fa-magnifying-glass" title="No match in the latest traces" message={`None of the ${scanned.count} traces checked matches these filters. Older traces may.`} />
            <div className="pb-6 text-center"><button onClick={goNext} className="text-caption font-semibold text-[var(--accent)] hover:text-[var(--accent-deep)]">Search older traces <i className="fas fa-arrow-right ml-1 text-[11px]" /></button></div>
          </div>
        ) : traces.length === 0 ? (
          <EmptyState icon="fa-inbox" title="No traces match these filters" message="Try widening your filters, or ask the tutor a question to generate a new trace." />
        ) : (
          <>
            {/* The question text is only recorded when content capture is on.
                With it off the column held the words "Open the trace" on every
                single row, promising a column of questions and delivering a
                column of instructions. It appears when there is something to
                put in it. */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-caption text-[var(--muted)]">
                    <th className="px-5 py-3 font-medium">Time</th>
                    {showQuestion && <th className="px-4 py-3 font-medium">Question</th>}
                    <th className="px-4 py-3 font-medium">Route</th>
                    {/* "Outcome", because that is what it now reports. The
                        filter beside the search still filters status, which is
                        a different question and keeps its own name. */}
                    <th className="px-4 py-3 font-medium">Outcome</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Tokens</th>
                    <th className="px-4 py-3 font-medium">Memory</th>
                    <th className="px-4 py-3 font-medium">Trace ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {traces.map(t => (
                    <tr key={t.traceId} onClick={() => router.push(`/admin/rag-traces/traces/${encodeURIComponent(t.traceId)}`)} className="hover:bg-[var(--surface)] transition-colors cursor-pointer group">
                      <td className="px-5 py-3.5 text-caption text-[var(--text)] whitespace-nowrap">{fmtDateTime(t.timestamp)}</td>
                      {showQuestion && <td className="px-4 py-3.5 text-caption text-[var(--text)] max-w-[280px] truncate">{t.questionPreview ?? '\u2014'}</td>}
                      <td className="px-4 py-3.5 text-caption text-[var(--text)] whitespace-nowrap">{routeLabel(t.route)}</td>
                      <td className="px-4 py-3.5 text-caption whitespace-nowrap">
                        {(() => {
                          const o = outcomeOf(t);
                          return <span className={o.attention ? 'font-semibold text-[var(--gold)]' : 'text-[var(--text)]'}>{o.text}</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3.5 text-caption text-[var(--text)] tabular-nums">{fmtMs(t.durationMs)}</td>
                      <td className="px-4 py-3.5 text-caption text-[var(--text)] truncate max-w-[140px]">{t.model ?? '—'}</td>
                      <td className="px-4 py-3.5 text-caption text-[var(--text)] tabular-nums">{t.totalTokens ?? '—'}</td>
                      <td className="px-4 py-3.5 text-caption text-[var(--text)] whitespace-nowrap">{memoryResultLabel(t.memoryResult)}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-[var(--muted2)] font-mono truncate max-w-[120px]">{t.traceId}</span>
                          {/* The click used to do its work silently, so the
                              only way to know it had copied was to paste it
                              somewhere and look. The icon is replaced by the
                              word for a moment instead. */}
                          {copiedId === t.traceId ? (
                            <span className="text-[11px] font-semibold text-[var(--accent)]" role="status">Copied</span>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); copyTraceId(t.traceId); }}
                              className="text-[var(--muted2)] hover:text-[var(--accent-deep)] transition-colors"
                              aria-label="Copy trace ID"
                            >
                              <i className="far fa-copy text-[11px]" />
                            </button>
                          )}
                        </div>
                      </td>
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
      {!unavailable && !error && !loading && traces.length > 0 && (
        <CursorPagination hasPrev={pageIndex > 0} hasNext={!!nextCursor} onPrev={goPrev} onNext={goNext} loading={loading} label={`${traces.length} trace${traces.length !== 1 ? 's' : ''} on this page`} />
      )}
    </div>
  );
}
