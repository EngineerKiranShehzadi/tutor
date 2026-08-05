import { getSpans } from '@arizeai/phoenix-client/spans';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import { mapPhoenixSpan, type RawPhoenixSpan } from './normalize';
import { getSpanAnnotationsFor, getSpanNotesFor } from './annotations.service';
import type { ObservabilitySpan, Annotation, Note } from './types';

export interface SpanListFilters {
  cursor?: string | null;
  limit?: number;
  traceIds?: string[];
  parentId?: string | null;
  name?: string;
  spanKind?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  search?: string;
  model?: string;
}

export interface SpanListResult {
  spans: ObservabilitySpan[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
}

export async function listSpans(filters: SpanListFilters): Promise<SpanListResult> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

  const result = await withPhoenixRetry(() => getSpans({
    client: getPhoenixClient(),
    project: phoenixProject(),
    startTime: filters.startTime ?? undefined,
    endTime: filters.endTime ?? undefined,
    cursor: filters.cursor ?? undefined,
    limit,
    // Each of these is gated by the capability that actually mirrors the
    // client's own internal version check for that exact parameter
    // (verified against getSpans.js: traceIds -> GET_SPANS_TRACE_IDS,
    // spanKind/statusCode -> GET_SPANS_FILTERS — two DIFFERENT thresholds,
    // previously conflated under one `supportsSpanFiltering` flag).
    traceIds: caps.supportsSpanTraceIdFiltering && filters.traceIds && filters.traceIds.length > 0 ? filters.traceIds : undefined,
    parentId: filters.parentId ?? undefined,
    name: filters.name ?? undefined,
    spanKind: caps.supportsSpanKindStatusFiltering ? (filters.spanKind as never) : undefined,
    statusCode: caps.supportsSpanKindStatusFiltering && filters.status ? (filters.status.toUpperCase() as never) : undefined,
  }));

  let spans = (result.spans as unknown as RawPhoenixSpan[]).map(s => mapPhoenixSpan(s));

  if (filters.minLatencyMs !== undefined) spans = spans.filter(s => s.durationMs >= filters.minLatencyMs!);
  if (filters.maxLatencyMs !== undefined) spans = spans.filter(s => s.durationMs <= filters.maxLatencyMs!);
  if (filters.model) spans = spans.filter(s => s.model === filters.model);
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    spans = spans.filter(s => [s.name, s.spanId, s.traceId, s.input, s.output].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }

  return { spans, nextCursor: result.nextCursor ?? null, appliedFilters: filters as Record<string, unknown> };
}

export async function getSpanDetail(spanId: string): Promise<{ span: ObservabilitySpan; annotations: Annotation[]; notes: Note[] } | null> {
  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');

  const result = await withPhoenixRetry(() => getSpans({
    client: getPhoenixClient(),
    project: phoenixProject(),
    spanIds: caps.supportsSpanIdFiltering ? [spanId] : undefined,
    limit: caps.supportsSpanIdFiltering ? 1 : 500,
  }));

  const rawSpans = result.spans as unknown as RawPhoenixSpan[];
  const match = rawSpans.find(s => (s.context?.span_id ?? s.span_id) === spanId);
  if (!match) return null;

  const span = mapPhoenixSpan(match);
  const [annotations, notes] = await Promise.all([
    getSpanAnnotationsFor(spanId).catch(() => []),
    getSpanNotesFor(spanId).catch(() => []),
  ]);
  return { span, annotations, notes };
}
