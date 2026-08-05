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

// Every field here is safe-by-construction (id/count/duration/status/model
// string) — call sites must never spread an untrusted object into this.
export type SafeMetadata = Record<string, string | number | boolean | null | undefined>;

export interface FinishedSpan {
  name: string;
  startedAt: number; // epoch ms
  durationMs: number;
  status: SpanStatus;
  metadata: SafeMetadata;
  errorCode?: string;
}

export interface FinishedTrace {
  traceId: string;
  rootName: string;
  startedAt: number; // epoch ms
  durationMs: number;
  status: SpanStatus;
  attributes: SafeMetadata;
  spans: FinishedSpan[];
}
