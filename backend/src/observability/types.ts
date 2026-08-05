import type { OpenInferenceSpanKind } from './otel-semconv';

export type SpanStatus = 'SUCCESS' | 'ERROR' | 'SKIPPED' | 'FALLBACK';

export type RoutingMethod = 'DETERMINISTIC_RULE' | 'LLM_CLASSIFIER' | 'SAFE_DEFAULT';

export type MemoryResult =
  | 'EXACT_HIT' | 'SEMANTIC_HIT' | 'MISS' | 'STALE'
  | 'INVALID_SOURCE' | 'LOOKUP_FAILED' | 'WRITE_FAILED' | 'ENTRY_CREATED' | 'NOT_ATTEMPTED';

export type NotFoundReason =
  | 'NO_VECTOR_CANDIDATES'
  | 'ALL_CANDIDATES_BELOW_RERANK_FLOOR'
  | 'EMPTY_LECTURE'
  | 'EMBEDDING_FAILURE'
  | 'VECTOR_SEARCH_FAILURE'
  | 'RERANKER_FAILURE'
  | 'SUMMARY_CONTENT_EMPTY';

export type GeminiOperationType =
  | 'ROUTE_CLASSIFICATION' | 'QUERY_REWRITE' | 'GROUNDED_ANSWER'
  | 'PARTIAL_SUMMARY' | 'FINAL_SUMMARY';

// Bumped whenever the *guarantee* behind a custom root-span attribute this
// codebase's overview aggregation depends on changes — not on every deploy,
// and never inferred from deploy time alone. Version "2" is this contract,
// introduced by the telemetry-coverage audit:
//   - `memoryResult` is set on every FACT_QUESTION/CONTEXTUAL_FOLLOW_UP/
//     GREETING/LECTURE_SUMMARY trace (one of the MemoryResult values above;
//     never silently omitted).
//   - `candidateCount` is set on every trace whose route is FACT_QUESTION or
//     CONTEXTUAL_FOLLOW_UP (the only routes that ever call vector-search);
//     GREETING/LECTURE_SUMMARY never set it, by design.
//   - `notFoundReason` is set whenever a trace resolves to a hardcoded
//     not-found answer (empty lecture/summary, zero vector candidates, all
//     candidates below the rerank floor) or fails at the embedding/
//     vector-search/reranker stage — see chat.service.ts's outer catch.
// Every Phoenix trace recorded before this marker existed (or emitted by an
// older/partial build of the exporter) has no `observabilitySchemaVersion`
// attribute at all — aggregation must treat that absence as "unknown
// coverage", never as proof any of the above guarantees held. See
// services/observability/overview-metrics.ts for where this is enforced.
export const OBSERVABILITY_SCHEMA_VERSION = '2';

// Every field here is safe-by-construction (id/count/duration/status/model
// string) — call sites must never spread an untrusted object into this
// without going through sanitizeAttributes() first (see sanitize.ts).
export type SafeMetadata = Record<string, string | number | boolean | null | undefined>;

export interface SpanEvent {
  name: string;
  timestamp: number; // epoch ms
  attributes?: SafeMetadata;
}

export interface SpanException {
  errorCode: string;   // classifyErrorCode() output — never the raw message
  message: string;     // sanitized, truncated
  stack?: string;      // only ever populated outside production, sanitized
}

export interface FinishedSpan {
  spanId: string;
  // Always a concrete span ID — either an ancestor span's spanId, or the
  // trace's rootSpanId for a top-level stage. The synthetic root span
  // itself is represented separately via FinishedTrace.rootSpanId/
  // rootName/attributes, not as an entry in `spans[]`.
  parentSpanId: string;
  name: string;
  kind: OpenInferenceSpanKind;
  startedAt: number; // epoch ms
  durationMs: number;
  status: SpanStatus;
  statusMessage?: string;
  metadata: SafeMetadata;
  events: SpanEvent[];
  exception?: SpanException;
  errorCode?: string;
}

export interface FinishedTrace {
  traceId: string;
  rootSpanId: string;
  rootName: string;
  startedAt: number; // epoch ms
  durationMs: number;
  status: SpanStatus;
  attributes: SafeMetadata;
  spans: FinishedSpan[];
}
