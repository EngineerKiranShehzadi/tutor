import { getTraces } from '@arizeai/phoenix-client/traces';
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
  sort?: 'start_time' | 'latency_ms';
  order?: 'asc' | 'desc';
}

export interface TraceListResult {
  traces: TraceSummary[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
}

// Fields not natively filterable server-side by Phoenix's getTraces
// (custom RAG attributes like route/lectureId/memoryResult) are applied as
// a bounded in-memory pass over the current page only — documented here
// rather than silently claiming full cross-history filtering. Time range,
// sort, and cursor pagination ARE always applied server-side.
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

export async function listTraces(filters: TraceListFilters): Promise<TraceListResult> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsTraceListing) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support trace listing');

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);

  const result = await withPhoenixRetry(() => getTraces({
    client: getPhoenixClient(),
    project: phoenixProject(),
    startTime: filters.startTime ?? undefined,
    endTime: filters.endTime ?? undefined,
    sort: filters.sort ?? 'start_time',
    order: filters.order ?? 'desc',
    limit,
    cursor: filters.cursor ?? undefined,
    includeSpans: true,
    sessionId: filters.sessionId ?? undefined,
  }));

  const summaries = result.traces.map(t => {
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
  });

  return {
    traces: applyPageFilters(summaries, filters),
    nextCursor: result.nextCursor ?? null,
    appliedFilters: filters as Record<string, unknown>,
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
    // Debug/"Raw Data" tab in the admin UI, labeled "(sanitized)" — must
    // actually pass through the sanitizer like every other read-path value
    // (see sanitize.ts's header comment: phoenix.ts on export,
    // normalize.ts's mapPhoenixSpan on read). `result.spans` here is the
    // unmodified @arizeai/phoenix-client response, not the already-mapped
    // `spans` field above, so it needs its own pass.
    raw: { trace: { traceId, rootSpanId: root.spanId }, spans: sanitizeValue(result.spans) as unknown[] },
  };
}
