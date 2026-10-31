import { getSpans } from '@arizeai/phoenix-client/spans';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import {
  mapPhoenixSpan, extractTraceSummary, buildSpanTree, buildTimeline, buildCriticalPath, depthMapFromTree,
  type RawPhoenixSpan,
} from './normalize';
import { getTraceAnnotationsFor, getTraceNotesFor } from './annotations.service';
import { sanitizeValue } from '../../observability/sanitize';
import { buildPhoenixTraceUrl } from './phoenix-links';
import type { TraceSummary, TraceDetail } from './types';

export interface TraceListFilters {
  cursor?: string | null;
  limit?: number;
  startTime?: string;
  endTime?: string;
  search?: string;
  traceId?: string;
  sessionId?: string;
  lectureId?: string;
  userId?: string;
  route?: string;
  status?: string;
  spanKind?: string;
  spanName?: string;
  model?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  memoryResult?: string;
  errorOnly?: boolean;
  errorCode?: string;
  sort?: 'start_time' | 'latency_ms';
  order?: 'asc' | 'desc';
}

export interface TraceListResult {
  traces: TraceSummary[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
  // Traces read from Phoenix to build this page. With an in-memory filter set
  // this can exceed traces.length; scanLimitReached says the search stopped at
  // FILTER_SCAN_LIMIT, so an empty page means "none in the traces checked",
  // not "none at all".
  scannedTraces: number;
  scanLimitReached: boolean;
}

// How many traces one filtered request reads at most — the same window the
// overview's counts (e.g. "Total errors") are computed over.
export const FILTER_SCAN_LIMIT = 500;

// Fields not natively filterable server-side by Phoenix's getTraces
// (custom RAG attributes like route/lectureId/memoryResult) are applied in
// memory. listTraces keeps reading pages until it has `limit` matches or has
// read FILTER_SCAN_LIMIT traces, so a page is never empty just because the
// newest traces didn't match. Time range, sort, session and cursor
// pagination are always applied server-side.
const hasPageFilters = (f: TraceListFilters): boolean =>
  !!(f.traceId || f.lectureId || f.userId || f.route || f.status || f.model || f.memoryResult || f.errorOnly || f.errorCode || f.search)
  || f.minLatencyMs !== undefined || f.maxLatencyMs !== undefined;

function applyPageFilters(traces: TraceSummary[], f: TraceListFilters): TraceSummary[] {
  return traces.filter(t => {
    if (f.traceId && t.traceId !== f.traceId) return false;
    if (f.sessionId && t.sessionId !== f.sessionId) return false;
    if (f.lectureId && t.lectureId !== f.lectureId) return false;
    if (f.userId && t.userId !== f.userId) return false;
    if (f.route && t.route !== f.route) return false;
    if (f.status && t.status.toUpperCase() !== f.status.toUpperCase()) return false;
    if (f.model && t.model !== f.model) return false;
    if (f.memoryResult && t.memoryResult !== f.memoryResult) return false;
    if (f.errorOnly && t.status !== 'ERROR') return false;
    if (f.errorCode && t.errorCode !== f.errorCode) return false;
    if (f.minLatencyMs !== undefined && t.durationMs < f.minLatencyMs) return false;
    if (f.maxLatencyMs !== undefined && t.durationMs > f.maxLatencyMs) return false;
    if (f.search) {
      const needle = f.search.toLowerCase();
      const haystack = [t.traceId, t.requestId, t.questionPreview, t.answerPreview].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

interface PhoenixTracePage {
  traces: {
    trace_id: string; start_time: string; end_time: string; spans?: unknown[] | null;
    token_count_prompt?: number; token_count_completion?: number; token_count_total?: number;
  }[];
  nextCursor: string | null;
}

// The same request @arizeai/phoenix-client's getTraces sends, plus `error=true`
// for an errors-only list: Phoenix then returns only traces with an errored
// span (a superset of ERROR-status traces), so the in-memory check below
// rarely has to read past the first page. A server that predates the
// parameter ignores it and the scan still finds the same traces, just slower.
async function fetchTracePage(filters: TraceListFilters, cursor: string | null, limit: number): Promise<PhoenixTracePage> {
  const query: Record<string, unknown> = {
    limit,
    sort: filters.sort ?? 'start_time',
    order: filters.order ?? 'desc',
    include_spans: true,
  };
  if (cursor) query.cursor = cursor;
  if (filters.startTime) query.start_time = filters.startTime;
  if (filters.endTime) query.end_time = filters.endTime;
  if (filters.sessionId) query.session_identifier = [filters.sessionId];
  if (filters.errorOnly || filters.errorCode) query.error = true;
  const { data, error } = await getPhoenixClient().GET('/v1/projects/{project_identifier}/traces', {
    params: { path: { project_identifier: phoenixProject().projectName }, query: query as never },
  });
  if (error) throw error;
  return { traces: (data?.data ?? []) as PhoenixTracePage['traces'], nextCursor: data?.next_cursor ?? null };
}

const toSummary = (t: PhoenixTracePage['traces'][number]): TraceSummary => {
  const rawSpans = (t.spans ?? []) as unknown as RawPhoenixSpan[];
  const spans = rawSpans.map(s => mapPhoenixSpan(s, t.trace_id));
  const root = spans.find(s => !s.parentId) ?? spans[0] ?? null;
  const durationMs = Number.isFinite(new Date(t.start_time).getTime()) && Number.isFinite(new Date(t.end_time).getTime())
    ? new Date(t.end_time).getTime() - new Date(t.start_time).getTime()
    : root?.durationMs ?? 0;
  return extractTraceSummary(t.trace_id, root, spans, {
    durationMs,
    timestamp: t.start_time,
    cumulativeTokens: {
      prompt: t.token_count_prompt ?? null,
      completion: t.token_count_completion ?? null,
      total: t.token_count_total ?? null,
    },
  });
};

export async function listTraces(filters: TraceListFilters): Promise<TraceListResult> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsTraceListing) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support trace listing');

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const filtering = hasPageFilters(filters);

  // Each page asks for no more traces than matches are still needed, so a page
  // can never hold more than `limit` matches and Phoenix's cursor (which points
  // past the last trace it returned) never skips one.
  const matched: TraceSummary[] = [];
  let cursor: string | null = filters.cursor ?? null;
  let scanned = 0;
  for (;;) {
    const pageSize = Math.min(limit - matched.length, FILTER_SCAN_LIMIT - scanned);
    const page = await withPhoenixRetry(() => fetchTracePage(filters, cursor, pageSize));
    scanned += page.traces.length;
    const summaries = page.traces.map(toSummary);
    matched.push(...(filtering ? applyPageFilters(summaries, filters) : summaries));
    cursor = page.nextCursor;
    if (!filtering || !cursor || matched.length >= limit || scanned >= FILTER_SCAN_LIMIT) break;
  }

  return {
    traces: matched,
    nextCursor: cursor,
    appliedFilters: filters as Record<string, unknown>,
    scannedTraces: scanned,
    scanLimitReached: filtering && cursor !== null && matched.length < limit,
  };
}

export async function getTraceDetail(traceId: string): Promise<TraceDetail> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');

  const result = await withPhoenixRetry(() => getSpans({
    client: getPhoenixClient(),
    project: phoenixProject(),
    traceIds: [traceId],
    limit: 1000,
  }));

  const rawSpans = result.spans as unknown as RawPhoenixSpan[];
  if (rawSpans.length === 0) {
    throw new ObservabilityError('TRACE_NOT_FOUND', `No spans found for trace ${traceId}`);
  }

  const spans = rawSpans.map(s => mapPhoenixSpan(s, traceId)).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const root = spans.find(s => !s.parentId) ?? spans[0];
  const traceStartMs = new Date(root.startTime).getTime();
  const traceEndMs = Math.max(...spans.map(s => new Date(s.endTime).getTime()));
  const totalDurationMs = Math.max(0, traceEndMs - traceStartMs);

  const nonRootSpans = spans.filter(s => s.spanId !== root.spanId);
  const spanTree = buildSpanTree(spans, root.spanId, totalDurationMs);
  const depthById = depthMapFromTree(spanTree);
  const timeline = buildTimeline(nonRootSpans, traceStartMs, totalDurationMs, depthById);
  const criticalPath = buildCriticalPath(spanTree);
  const summary = extractTraceSummary(traceId, root, spans, { durationMs: totalDurationMs, timestamp: root.startTime });
  const [annotations, notes] = await Promise.all([
    getTraceAnnotationsFor(root.spanId).catch(() => []),
    getTraceNotesFor(root.spanId).catch(() => []),
  ]);

  return {
    summary,
    rootSpan: root,
    spans: nonRootSpans,
    spanTree,
    timeline,
    criticalPath,
    annotations,
    notes,
    phoenixTraceUrl: await buildPhoenixTraceUrl(traceId),
    // Debug/"Raw Data" tab in the admin UI, labeled "(sanitized)" — must
    // actually pass through the sanitizer like every other read-path value
    // (see sanitize.ts's header comment: phoenix.ts on export,
    // normalize.ts's mapPhoenixSpan on read). `result.spans` here is the
    // unmodified @arizeai/phoenix-client response, not the already-mapped
    // `spans` field above, so it needs its own pass.
    raw: { trace: { traceId, rootSpanId: root.spanId }, spans: sanitizeValue(result.spans) as unknown[] },
  };
}
