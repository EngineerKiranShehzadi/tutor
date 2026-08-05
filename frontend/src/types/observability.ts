// Mirrors backend/src/services/observability/types.ts response contracts —
// keep in sync when the backend shape changes.

export interface ObservabilityEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface ObservabilityException {
  type: string;
  message: string;
}

export interface RetrievalDocument {
  id: string;
  score: number | null;
  rank: number | null;
  content?: string;
}

export interface TokenUsage {
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

export interface ObservabilitySpan {
  spanId: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: string;
  status: string;
  statusMessage: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  events: ObservabilityEvent[];
  exception: ObservabilityException | null;
  input: string | null;
  output: string | null;
  model: string | null;
  provider: string | null;
  tokens: TokenUsage | null;
  retrievalDocuments: RetrievalDocument[] | null;
  errorCode: string | null;
}

export interface SpanTreeNode extends ObservabilitySpan {
  depth: number;
  percentOfTrace: number;
  children: SpanTreeNode[];
}

export interface TimelineSpan extends ObservabilitySpan {
  depth: number;
  offsetMs: number;
  percentOfTrace: number;
}

export interface CriticalPathItem {
  spanId: string;
  name: string;
  durationMs: number;
  percentOfTrace: number;
}

export interface TraceSummary {
  traceId: string;
  rootSpanId: string | null;
  requestId: string | null;
  timestamp: string;
  durationMs: number;
  status: string;
  statusMessage: string | null;
  route: string | null;
  routingMethod: string | null;
  questionPreview: string | null;
  answerPreview: string | null;
  lectureId: string | null;
  sessionId: string | null;
  userId: string | null;
  memoryResult: string | null;
  retrievalCount: number | null;
  selectedChunkCount: number | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  spanCount: number;
  errorCode: string | null;
  fallbackReason: string | null;
  environment: string | null;
  schemaVersion: string | null;
}

export interface Annotation {
  id: string;
  name: string;
  label: string | null;
  score: number | null;
  annotatorKind: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Note {
  id: string;
  note: string;
  createdAt: string;
}

export interface TraceDetail {
  summary: TraceSummary;
  rootSpan: ObservabilitySpan | null;
  spans: ObservabilitySpan[];
  spanTree: SpanTreeNode[];
  timeline: TimelineSpan[];
  criticalPath: CriticalPathItem[];
  annotations: Annotation[];
  notes: Note[];
  raw: { trace: unknown; spans: unknown[] };
}

export interface TraceListResult {
  traces: TraceSummary[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
}

export interface SpanListResult {
  spans: ObservabilitySpan[];
  nextCursor: string | null;
  appliedFilters: Record<string, unknown>;
}

export interface SessionSummary {
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  traceCount: number;
  totalDurationMs: number;
  // null on the session LIST endpoint (genuinely uncomputed there, not
  // zero — see backend sessions.service.ts). Always populated on the
  // session DETAIL endpoint.
  totalPromptTokens: number | null;
  totalCompletionTokens: number | null;
  totalTokens: number | null;
  successCount: number | null;
  errorCount: number | null;
  routes: string[] | null;
  lectureIds: string[] | null;
}

export interface SessionTurn {
  traceId: string;
  startTime: string;
  endTime: string;
  input: string | null;
  output: string | null;
  route: string | null;
  durationMs: number;
  status: string;
}

export interface SessionDetail {
  summary: SessionSummary;
  turns: SessionTurn[];
  traces: TraceSummary[];
}

// route/model distributions require span attributes that Phoenix's
// getTraces({includeSpans:true}) response doesn't carry — see the backend
// type's comment (services/observability/types.ts). This shape says
// honestly whether the chart is based on a sample, or is unavailable
// altogether, rather than silently showing a partial/all-"unknown" chart.
export interface DistributionResult {
  data: Record<string, number>;
  available: boolean;
  sampled: boolean;
  sampleSize: number;
  unavailableReason?: string;
}

// Availability-aware result for a single Overview metric derived from full
// span attributes (memory, zero-retrieval, fallback) — sibling shape to
// DistributionResult above, just for a scalar/object instead of a category
// breakdown. Three states a card must render distinctly:
//   1. { value: 0 (or a real object/number), available: true }              -> genuine measured value, incl. real zero
//   2. { value: null, available: true, unavailableReason: '...' }           -> fetched OK, nothing to measure ("No memory lookups in this period", "No traces in this period")
//   3. { value: null, available: false, unavailableReason: '...' }          -> could not fetch the telemetry at all ("Unavailable")
// Always branch on `available`, not on whether `unavailableReason` is set —
// it's present in both (2) and (3).
//
// Coverage fields (optional — only set when the backend classified
// per-trace eligibility for this specific metric): eligibleSampleSize is
// how many traces `value` is actually derived from; incompleteSampleSize is
// how many were excluded for lacking the required telemetry (legacy/
// partial instrumentation — never folded into `value`); partial is true
// whenever incompleteSampleSize > 0; coveragePercent is
// eligibleSampleSize / (eligibleSampleSize + incompleteSampleSize) * 100.
export interface MetricResult<T> {
  value: T | null;
  available: boolean;
  sampled: boolean;
  sampleSize: number;
  unavailableReason?: string;
  eligibleSampleSize?: number;
  incompleteSampleSize?: number;
  partial?: boolean;
  coveragePercent?: number;
}

// How many traces in the enriched sample carry the current observability
// schema-version marker at all — a coarser, whole-sample companion to each
// metric's own eligibleSampleSize/incompleteSampleSize above (different
// metrics have different eligibility rules; this total is disclosure-only).
export interface TelemetryCoverage {
  totalTraces: number;
  eligibleTraces: number;
  legacyOrIncompleteTraces: number;
}

export interface MemoryMetrics {
  hits: MetricResult<number>;
  misses: MetricResult<number>;
  lookupFailures: MetricResult<number>;
  notAttempted: MetricResult<number>;
  hitRate: MetricResult<number>;
}

export interface ZeroRetrievalMetric extends MetricResult<number> {
  attemptedCount: number;
}

export interface FallbackBreakdown {
  retrieval: number;
  emptySelectedChunks: number;
  errorRecovery: number;
  lectureUnavailable: number;
  other: number;
}

export interface OverviewMetrics {
  range: { startTime: string; endTime: string };
  totalTraces: number;
  successfulTraces: number;
  failedTraces: number;
  successRate: number;
  errorRate: number;
  latencyMs: { avg: number; median: number; p90: number; p95: number; p99: number; min: number; max: number };
  totalSpans: number;
  avgSpansPerTrace: number;
  tokens: { prompt: number; completion: number; total: number; avgPerRequest: number };
  llmCallCount: number;
  retrievalCallCount: number;
  rerankerCallCount: number;
  memory: MemoryMetrics;
  zeroRetrievalCount: ZeroRetrievalMetric;
  fallbackCount: MetricResult<number>;
  fallbackBreakdown: MetricResult<FallbackBreakdown>;
  telemetryCoverage: TelemetryCoverage;
  routeDistribution: DistributionResult;
  statusDistribution: Record<string, number>;
  spanKindDistribution: Record<string, number>;
  modelDistribution: DistributionResult;
  slowestOperations: { name: string; avgDurationMs: number; count: number }[];
  mostFrequentErrors: { errorCode: string; count: number }[];
  timeSeries: {
    bucket: string;
    requestCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    promptTokens: number;
    completionTokens: number;
    successCount: number;
    errorCount: number;
  }[];
}

// Mirrors backend/src/services/observability/capabilities.ts's CapabilityState.
export type CapabilityState = 'supported' | 'unsupported_by_server' | 'unsupported_by_client' | 'unreachable' | 'unknown';

export interface CapabilityDetail {
  state: CapabilityState;
  detail?: string;
}

export interface PhoenixCapabilities {
  serverVersion: string | null;
  reachable: boolean;
  observabilityEnabled: boolean;
  phoenixEnabled: boolean;
  // Convenience booleans — each is `details.<key>.state === 'supported'`.
  // Prefer `details` for the full supported / unsupported-by-server /
  // unsupported-by-client / unreachable / unknown distinction.
  supportsTraceListing: boolean;
  supportsInlineSpans: boolean;
  supportsSpanTraceIdFiltering: boolean;
  supportsSpanIdFiltering: boolean;
  supportsSpanKindStatusFiltering: boolean;
  supportsAttributeFiltering: boolean;
  supportsSessions: boolean;
  supportsSessionTurns: boolean;
  supportsSessionAnnotations: boolean;
  supportsSessionAnnotationReads: boolean;
  supportsSessionNotes: boolean;
  supportsTraceNotes: boolean;
  supportsSpanNotes: boolean;
  supportsTokenAggregates: boolean;
  supportsAnnotations: boolean;
  /** @deprecated equals supportsSpanNotes && supportsTraceNotes — prefer the specific flags. */
  supportsNotes: boolean;
  details: Record<string, CapabilityDetail>;
  checkedAt: string;
}

export interface ObservabilityStatus {
  observabilityEnabled: boolean;
  phoenixEnabled: boolean;
  phoenixReachable: boolean;
  projectName: string;
  serverVersion: string | null;
  lastSuccessfulQueryAt: string | null;
  endpointLabel: string;
  samplingRate: number;
  contentCaptureEnabled: boolean;
  recentErrorMessage: string | null;
}

export type ObservabilityErrorCode =
  | 'PHOENIX_DISABLED' | 'PHOENIX_UNREACHABLE' | 'PHOENIX_TIMEOUT' | 'PHOENIX_UNSUPPORTED_FEATURE'
  | 'TRACE_NOT_FOUND' | 'SPAN_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INVALID_OBSERVABILITY_FILTER';

export interface ObservabilityApiError {
  success: false;
  code: ObservabilityErrorCode;
  message: string;
}
