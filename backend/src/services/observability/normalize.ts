import { sanitizeValue, isContentCaptureEnabled } from '../../observability/sanitize';
import { ATTR, OPENINFERENCE_SPAN_KIND } from '../../observability/otel-semconv';
import type {
  ObservabilitySpan, SpanTreeNode, TimelineSpan, CriticalPathItem, TraceSummary, RetrievalDocument, TokenUsage,
} from './types';

// Two genuinely different real Phoenix response shapes both flow through
// this type — verified directly against the installed @arizeai/
// phoenix-client's generated OpenAPI schemas (dist/src/__generated__/api/
// v1.d.ts) and confirmed live against a running Phoenix 19.13.0 server:
//
// 1. The standalone `getSpans()` endpoint (components.schemas.Span) — full
//    OTel-native shape, ids nested under `context: {trace_id, span_id}`,
//    carries `attributes`/`events`.
// 2. The *embedded* spans returned by `getTraces({ includeSpans: true })`
//    (components.schemas.TraceSpanData) — a deliberately minimal shape:
//    flat `span_id` (no `context`, so no per-span `trace_id` either — the
//    parent TraceData's own trace_id must be used instead), and NO
//    `attributes`/`events` field at all. Treating this shape as if it were
//    (1) crashes on `raw.context.span_id` for every real getTraces-based
//    trace-list request — this is not a hypothetical, it reproduced
//    against a live server on the very first `listTraces()` call.
export interface RawPhoenixSpan {
  id?: string;
  name: string;
  context?: { trace_id: string; span_id: string };
  span_id?: string;
  span_kind: string;
  parent_id?: string | null;
  start_time: string;
  end_time: string;
  status_code: string;
  status_message?: string | null;
  attributes?: Record<string, unknown> | null;
  events?: { name: string; timestamp: string; attributes?: Record<string, unknown> }[] | null;
}

function safeAttrs(attrs: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!attrs) return {};
  return sanitizeValue(attrs) as Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseRetrievalDocuments(attrs: Record<string, unknown>): RetrievalDocument[] | null {
  const raw = attrs[ATTR.RETRIEVAL_DOCUMENTS] ?? attrs[ATTR.RERANKER_OUTPUT_DOCUMENTS];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { id: unknown; score: unknown; rank: unknown }[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map(d => ({ id: String(d.id), score: num(d.score), rank: num(d.rank) }));
  } catch {
    return null;
  }
}

function parseTokens(attrs: Record<string, unknown>): TokenUsage | null {
  const prompt = num(attrs[ATTR.LLM_TOKEN_COUNT_PROMPT]);
  const completion = num(attrs[ATTR.LLM_TOKEN_COUNT_COMPLETION]);
  const total = num(attrs[ATTR.LLM_TOKEN_COUNT_TOTAL]);
  if (prompt === null && completion === null && total === null) return null;
  return { prompt, completion, total: total ?? (prompt !== null && completion !== null ? prompt + completion : null) };
}

// fallbackTraceId: the embedded TraceSpanData shape has no trace_id of its
// own (see RawPhoenixSpan's comment) — callers iterating spans within a
// known trace (listTraces/aggregate over getTraces({includeSpans:true}))
// must pass the parent TraceData's trace_id explicitly.
export function mapPhoenixSpan(raw: RawPhoenixSpan, fallbackTraceId?: string): ObservabilitySpan {
  const attributes = safeAttrs(raw.attributes);
  const start = new Date(raw.start_time).getTime();
  const end = new Date(raw.end_time).getTime();
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  return {
    spanId: raw.context?.span_id ?? raw.span_id ?? '',
    traceId: raw.context?.trace_id ?? fallbackTraceId ?? '',
    parentId: raw.parent_id ?? null,
    name: raw.name,
    kind: String(attributes[OPENINFERENCE_SPAN_KIND] ?? raw.span_kind ?? 'UNKNOWN').toUpperCase(),
    status: raw.status_code,
    statusMessage: raw.status_message ?? null,
    startTime: raw.start_time,
    endTime: raw.end_time,
    durationMs,
    attributes,
    events: (raw.events ?? []).map(e => ({ name: e.name, timestamp: e.timestamp, attributes: e.attributes ? safeAttrs(e.attributes) : undefined })),
    exception: attributes['error.code'] || attributes.errorCode
      ? { type: str(attributes['error.code'] ?? attributes.errorCode) ?? 'UNKNOWN_ERROR', message: str(attributes.statusMessage ?? raw.status_message) ?? 'An error occurred' }
      : null,
    input: str(attributes[ATTR.INPUT_VALUE]),
    output: str(attributes[ATTR.OUTPUT_VALUE]),
    model: str(attributes[ATTR.LLM_MODEL_NAME]),
    provider: str(attributes[ATTR.LLM_PROVIDER]),
    tokens: parseTokens(attributes),
    retrievalDocuments: parseRetrievalDocuments(attributes),
    errorCode: str(attributes['error.code'] ?? attributes.errorCode),
  };
}

// Builds a real tree from parentId relationships. Defensive against every
// malformed-data case the spec calls out: a span whose parent isn't in the
// set attaches directly under the (possibly synthetic) root; a cycle is
// broken via a `visiting` guard so this can never recurse infinitely;
// duplicate spanIds keep only the first occurrence.
export function buildSpanTree(spans: ObservabilitySpan[], rootSpanId: string | null, totalDurationMs: number): SpanTreeNode[] {
  const byId = new Map<string, ObservabilitySpan>();
  for (const s of spans) {
    if (!byId.has(s.spanId)) byId.set(s.spanId, s);
  }

  const childrenOf = new Map<string, ObservabilitySpan[]>();
  const topLevel: ObservabilitySpan[] = [];
  for (const s of byId.values()) {
    if (s.spanId === rootSpanId) continue; // root rendered by the caller, not as a tree node here
    const parentKnown = s.parentId && s.parentId !== rootSpanId && byId.has(s.parentId);
    if (parentKnown) {
      const key = s.parentId as string;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key)!.push(s);
    } else {
      topLevel.push(s); // parent is root, unknown, or null
    }
  }

  const visiting = new Set<string>();
  function build(span: ObservabilitySpan, depth: number): SpanTreeNode {
    const node: SpanTreeNode = {
      ...span,
      depth,
      percentOfTrace: totalDurationMs > 0 ? Math.min(100, (span.durationMs / totalDurationMs) * 100) : 0,
      children: [],
    };
    if (visiting.has(span.spanId)) return node; // cycle guard — stop descending
    visiting.add(span.spanId);
    const kids = (childrenOf.get(span.spanId) ?? []).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    node.children = kids.map(k => build(k, depth + 1));
    visiting.delete(span.spanId);
    return node;
  }

  return topLevel
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .map(s => build(s, 0));
}

export function buildTimeline(spans: ObservabilitySpan[], traceStartMs: number, totalDurationMs: number, depthById: Map<string, number>): TimelineSpan[] {
  return spans
    .map(s => ({
      ...s,
      depth: depthById.get(s.spanId) ?? 0,
      offsetMs: Math.max(0, new Date(s.startTime).getTime() - traceStartMs),
      percentOfTrace: totalDurationMs > 0 ? Math.min(100, (s.durationMs / totalDurationMs) * 100) : 0,
    }))
    .sort((a, b) => a.offsetMs - b.offsetMs);
}

export function depthMapFromTree(tree: SpanTreeNode[]): Map<string, number> {
  const map = new Map<string, number>();
  function walk(nodes: SpanTreeNode[]) {
    for (const n of nodes) {
      map.set(n.spanId, n.depth);
      walk(n.children);
    }
  }
  walk(tree);
  return map;
}

// Heuristic critical path: starting from the root's children, repeatedly
// descend into whichever child consumed the most wall-clock time — the
// chain of spans that together explain most of the trace's total duration.
export function buildCriticalPath(tree: SpanTreeNode[]): CriticalPathItem[] {
  const path: CriticalPathItem[] = [];
  let level = tree;
  while (level.length > 0) {
    const slowest = level.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
    path.push({ spanId: slowest.spanId, name: slowest.name, durationMs: slowest.durationMs, percentOfTrace: slowest.percentOfTrace });
    level = slowest.children;
  }
  return path;
}

// Extracts a flat TraceSummary from the root span's attributes (set by
// trace.setAttributes(...) in chat.service.ts and exported 1:1 in
// phoenix.ts) plus a cheap scan of the trace's LLM spans for model/tokens
// when the root span itself doesn't carry a cumulative total (falls back to
// Phoenix's own TraceData.token_count_* when the caller supplies one).
export function extractTraceSummary(
  traceId: string,
  rootSpan: ObservabilitySpan | null,
  allSpans: ObservabilitySpan[],
  overrides: { durationMs?: number; timestamp?: string; cumulativeTokens?: TokenUsage } = {}
): TraceSummary {
  const attrs = rootSpan?.attributes ?? {};
  const llmSpans = allSpans.filter(s => s.kind === 'LLM');
  const lastLlm = llmSpans[llmSpans.length - 1] ?? null;

  const cumulative = overrides.cumulativeTokens ?? llmSpans.reduce<TokenUsage>(
    (acc, s) => ({
      prompt: (acc.prompt ?? 0) + (s.tokens?.prompt ?? 0),
      completion: (acc.completion ?? 0) + (s.tokens?.completion ?? 0),
      total: (acc.total ?? 0) + (s.tokens?.total ?? 0),
    }),
    { prompt: null, completion: null, total: null }
  );

  const contentCaptured = isContentCaptureEnabled();

  return {
    traceId,
    rootSpanId: rootSpan?.spanId ?? null,
    requestId: str(attrs.requestId) ?? traceId,
    timestamp: overrides.timestamp ?? rootSpan?.startTime ?? new Date(0).toISOString(),
    durationMs: overrides.durationMs ?? rootSpan?.durationMs ?? 0,
    status: rootSpan?.status ?? 'UNKNOWN',
    statusMessage: rootSpan?.statusMessage ?? null,
    route: str(attrs.route),
    routingMethod: str(attrs.routeSelectionMethod),
    questionPreview: contentCaptured ? str(attrs[ATTR.INPUT_VALUE]) : null,
    answerPreview: contentCaptured ? str(attrs[ATTR.OUTPUT_VALUE]) : null,
    lectureId: str(attrs.lectureId),
    sessionId: str(attrs.sessionId),
    userId: str(attrs.studentId),
    memoryResult: str(attrs.memoryResult),
    retrievalCount: num(attrs.candidateCount),
    selectedChunkCount: num(attrs.selectedChunkCount),
    model: str(lastLlm?.model ?? attrs[ATTR.LLM_MODEL_NAME]),
    promptTokens: cumulative.prompt,
    completionTokens: cumulative.completion,
    totalTokens: cumulative.total,
    spanCount: allSpans.length,
    errorCode: str(attrs.errorCode ?? attrs['error.code']),
    fallbackReason: str(attrs.notFoundReason ?? attrs.fallbackReason),
    environment: str(attrs.environment),
    schemaVersion: str(attrs.observabilitySchemaVersion),
  };
}
