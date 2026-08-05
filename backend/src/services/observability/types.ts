// Normalized, sanitized response contracts served by the admin observability
// API. These are Phoenix-shaped data mapped into a stable shape our own
// frontend depends on — kept separate from `@arizeai/phoenix-client`'s raw
// generated types so a Phoenix client upgrade only ever touches normalize.ts.

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
  offsetMs: number; // ms since trace start
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
  // `observability.schema_version` (chat.service.ts's `observabilitySchemaVersion`
  // attribute) — null on any trace recorded before this marker existed, or
  // exported by a build that didn't set it. Overview aggregation (see
  // overview-metrics.ts) uses this to decide which metrics a trace is
  // ELIGIBLE to contribute to, never to guess at missing attribute values.
  schemaVersion: string | null;
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

export interface SessionSummary {
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  traceCount: number;
  totalDurationMs: number;
  // null on the list endpoint (listSessions doesn't return per-span data,
  // and computing these per row would be an N+1 Phoenix call) — genuinely
  // unknown, not zero. Always populated on the detail endpoint, which
  // computes them from real per-trace summaries. See sessions.service.ts.
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

// route/model are OpenInference span ATTRIBUTES (root span / LLM sub-spans
// respectively) — Phoenix's getTraces({includeSpans:true}) response used
// for the rest of the overview does not carry attributes at all (verified
// against the client's generated OpenAPI schema: TraceSpanData has no
// `attributes` field), so these two distributions are computed from a
// separate, bounded, batched enrichment fetch over a recent sample of
// traces rather than the full overview window. This shape makes that
// honest instead of silently presenting a partial/sampled result as if it
// were the full range.
export interface DistributionResult {
  data: Record<string, number>;
  /** false when no practical way to compute this exists right now (e.g. server/client lacks span trace-ID filtering, or the enrichment fetch failed) — render an explicit "unavailable" state, never a fake empty/zero chart. */
  available: boolean;
  /** true when `data` reflects only `sampleSize` of the traces in the overview window, not all of them. */
  sampled: boolean;
  sampleSize: number;
  unavailableReason?: string;
}

// Availability-aware result for any Overview metric derived from full span
// ATTRIBUTES (memory, retrieval, fallback — same enrichment dependency as
// DistributionResult above, just shaped for a single scalar/object instead
// of a category breakdown). Three states a consumer must render distinctly
// — see overview-metrics.ts for the classification logic that produces
// each one:
//
//   1. Genuine measured value (incl. real zero): { value: 0, available: true }
//   2. Fetched OK, nothing to measure this window: { value: null, available: true, unavailableReason: '...' }
//      (e.g. "No traces in this period" / "No memory lookups in this period")
//   3. Could not fetch the telemetry at all:       { value: null, available: false, unavailableReason: '...' }
//      (Phoenix unreachable, server/client lacks span trace-ID filtering, enrichment request failed)
//
// `unavailableReason` is set in both (2) and (3) — callers must branch on
// `available`, not on `unavailableReason`'s presence, to tell them apart.
//
// Coverage fields (all optional — absent on results that don't classify
// per-trace eligibility, e.g. the plain unavailableMetric() factory):
//   eligibleSampleSize   — traces whose telemetry this metric trusts.
//   incompleteSampleSize — traces excluded because their telemetry couldn't
//                          prove or disprove this metric (legacy/partial
//                          instrumentation) — NEVER folded into `value`.
//   partial              — true when incompleteSampleSize > 0, i.e. `value`
//                          reflects less than the full enriched sample.
//   coveragePercent      — eligibleSampleSize / (eligibleSampleSize +
//                          incompleteSampleSize) * 100, rounded to 1dp.
// A genuine measured zero (`value: 0, available: true`) is only ever
// returned when eligibleSampleSize > 0 — see overview-metrics.ts.
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

// Summarizes, at the whole-enriched-sample level, how many traces carry the
// current observability schema-version marker at all. This is a coarser,
// single-number companion to the per-metric eligibleSampleSize/
// incompleteSampleSize above (different metrics have different eligibility
// rules — see overview-metrics.ts — so this total is informational/UI-disclosure
// only, not a substitute for any individual metric's own coverage fields.
export interface TelemetryCoverage {
  totalTraces: number;
  eligibleTraces: number;
  legacyOrIncompleteTraces: number;
}

// zeroRetrievalCount's shape, extended with the true denominator
// (retrieval-attempting requests in the sample) for tooltip/context — the
// headline `value` is the numerator (zero-candidate requests) alone.
export interface ZeroRetrievalMetric extends MetricResult<number> {
  attemptedCount: number;
}

// hits/misses/lookupFailures/notAttempted are real per-category counts
// (never null while available:true — a category genuinely had zero members
// this window is itself a measured fact, not "unknown"). hitRate is the
// one field that can legitimately be null while available:true: it's a
// ratio, and hits+misses===0 has no defined ratio — see
// overview-metrics.ts's computeMemoryMetrics for the exact rule.
export interface MemoryMetrics {
  hits: MetricResult<number>;
  misses: MetricResult<number>;
  lookupFailures: MetricResult<number>;
  notAttempted: MetricResult<number>;
  hitRate: MetricResult<number>;
}

// Sub-classification of `fallbackCount` — see overview-metrics.ts's
// classifyFallbackReason for exactly which `notFoundReason` values map to
// each bucket. `other` catches any notFoundReason value not in the known
// NotFoundReason union (forward-compatible with a future reason the
// aggregation hasn't been taught about yet, without silently dropping it).
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
  // Count of retrieval-attempting requests (candidateCount attribute
  // present, i.e. route went through vector-search) whose candidate count
  // was exactly 0. Requests on routes that never attempt retrieval
  // (GREETING, LECTURE_SUMMARY) are excluded, not counted as zero — see
  // overview-metrics.ts's computeZeroRetrievalMetric.
  zeroRetrievalCount: ZeroRetrievalMetric;
  fallbackCount: MetricResult<number>;
  fallbackBreakdown: MetricResult<FallbackBreakdown>;
  // How many traces in the enriched sample carry the current
  // observabilitySchemaVersion marker — see TelemetryCoverage's doc comment.
  telemetryCoverage: TelemetryCoverage;
  routeDistribution: DistributionResult;
  statusDistribution: Record<string, number>;
  spanKindDistribution: Record<string, number>;
  modelDistribution: DistributionResult;
  slowestOperations: { name: string; avgDurationMs: number; count: number }[];
  mostFrequentErrors: { errorCode: string; count: number }[];
  timeSeries: {
    bucket: string; // ISO timestamp of the bucket start
    requestCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    promptTokens: number;
    completionTokens: number;
    successCount: number;
    errorCount: number;
  }[];
}

export interface ObservabilityStatus {
  observabilityEnabled: boolean;
  phoenixEnabled: boolean;
  phoenixReachable: boolean;
  projectName: string;
  serverVersion: string | null;
  lastSuccessfulQueryAt: string | null;
  endpointLabel: string; // safe host:port label, never the raw URL w/ creds
  samplingRate: number;
  contentCaptureEnabled: boolean;
  recentErrorMessage: string | null;
}
