import { getTraces } from '@arizeai/phoenix-client/traces';
import { getSpans } from '@arizeai/phoenix-client/spans';
import { env } from '../../config/env';
import { getPhoenixClient, phoenixProject, withPhoenixRetry } from './phoenix-client';
import { getPhoenixCapabilities, type PhoenixCapabilities } from './capabilities';
import { ObservabilityError } from './errors';
import { mapPhoenixSpan, extractTraceSummary } from './normalize';
import type { RawPhoenixSpan } from './normalize';
import { computeMemoryMetrics, computeZeroRetrievalMetric, computeFallbackMetrics, unavailableMetric } from './overview-metrics';
import { OBSERVABILITY_SCHEMA_VERSION } from '../../observability/types';
import type { DistributionResult, FallbackBreakdown, MemoryMetrics, MetricResult, OverviewMetrics, TelemetryCoverage, TraceSummary, ZeroRetrievalMetric } from './types';

export interface OverviewFilters {
  startTime?: string;
  endTime?: string;
  lectureId?: string;
  sessionId?: string;
  route?: string;
  status?: string;
  environment?: string;
}

// Hard cap on how many traces a single overview computation will pull into
// memory — bounded, documented aggregation rather than an unbounded scan.
// Combined with the short-lived cache below, this keeps overview requests
// cheap even on a busy project.
const OVERVIEW_TRACE_LIMIT = 500;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Picks a bucket width so a chart never renders more than ~60 points
// regardless of the selected range — minute buckets for a short range,
// hour buckets for a day-scale range, day buckets beyond that.
function bucketWidthMs(rangeMs: number): number {
  const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (rangeMs <= 2 * HOUR) return MINUTE * 5;
  if (rangeMs <= 2 * DAY) return HOUR;
  return DAY;
}

function buildTimeSeries(traces: TraceSummary[]): OverviewMetrics['timeSeries'] {
  if (traces.length === 0) return [];
  const timestamps = traces.map(t => new Date(t.timestamp).getTime());
  const rangeMs = Math.max(1, Math.max(...timestamps) - Math.min(...timestamps));
  const width = bucketWidthMs(rangeMs);

  const buckets = new Map<number, TraceSummary[]>();
  for (const t of traces) {
    const bucketStart = Math.floor(new Date(t.timestamp).getTime() / width) * width;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart)!.push(t);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, bucketTraces]) => {
      const lat = bucketTraces.map(t => t.durationMs).sort((a, b) => a - b);
      return {
        bucket: new Date(bucketStart).toISOString(),
        requestCount: bucketTraces.length,
        avgLatencyMs: lat.reduce((a, b) => a + b, 0) / lat.length,
        p95LatencyMs: percentile(lat, 95),
        promptTokens: bucketTraces.reduce((s, t) => s + (t.promptTokens ?? 0), 0),
        completionTokens: bucketTraces.reduce((s, t) => s + (t.completionTokens ?? 0), 0),
        successCount: bucketTraces.filter(t => t.status === 'SUCCESS' || t.status === 'OK').length,
        errorCount: bucketTraces.filter(t => t.status === 'ERROR').length,
      };
    });
}

// route/model/memory/zero-retrieval/fallback all live on span ATTRIBUTES
// (root span for route/memory/retrieval/fallback, LLM sub-spans for model)
// which getTraces({includeSpans:true})'s embedded span shape never carries
// (see types.ts's DistributionResult comment). getSpans DOES accept
// multiple trace IDs in one request, so rather than either (a) showing
// "unknown"/flat-zero for 100% of the data, or (b) firing one getSpans
// call per trace (a real N+1), or (c) firing a separate getSpans call per
// metric, this fetches full attribute-rich spans for a small, bounded,
// most-recent slice of the overview's traces in ONE batched request and
// derives every attribute-dependent metric from that same enriched result,
// clearly labeled as a sample when the overview window is larger than it.
const ENRICHMENT_SAMPLE_LIMIT = 100;
// Phoenix's server enforces its own hard cap on `limit` for GET .../spans —
// verified live: 1000 succeeds, 3000 returns 422 Unprocessable Content.
// If the sampled traces collectively carry more spans than this, later
// traces in the sample simply won't have a match in the response and are
// skipped (not guessed) — see the `!rawForTrace` check below, reflected
// honestly in the returned `sampleSize`.
const ENRICHMENT_SPAN_FETCH_LIMIT = 1000;

// Exported for test-observability-overview-metrics.ts: the traces.length===0
// and !caps.supportsSpanTraceIdFiltering branches below never touch the
// network, so they're directly unit-testable with synthetic
// TraceSummary[]/PhoenixCapabilities fixtures — no live Phoenix required.
export interface EnrichedOverviewMetrics {
  routeDistribution: DistributionResult;
  modelDistribution: DistributionResult;
  memory: MemoryMetrics;
  zeroRetrievalCount: ZeroRetrievalMetric;
  fallbackCount: MetricResult<number>;
  fallbackBreakdown: MetricResult<FallbackBreakdown>;
  telemetryCoverage: TelemetryCoverage;
}

const ZERO_COVERAGE: TelemetryCoverage = { totalTraces: 0, eligibleTraces: 0, legacyOrIncompleteTraces: 0 };

export function unavailableEnrichedMetrics(reason: string): EnrichedOverviewMetrics {
  const dist: DistributionResult = { data: {}, available: false, sampled: false, sampleSize: 0, unavailableReason: reason };
  return {
    routeDistribution: dist,
    modelDistribution: { ...dist },
    memory: {
      hits: unavailableMetric(reason),
      misses: unavailableMetric(reason),
      lookupFailures: unavailableMetric(reason),
      notAttempted: unavailableMetric(reason),
      hitRate: unavailableMetric(reason),
    },
    zeroRetrievalCount: { ...unavailableMetric<number>(reason), attemptedCount: 0 },
    fallbackCount: unavailableMetric(reason),
    fallbackBreakdown: unavailableMetric(reason),
    telemetryCoverage: { ...ZERO_COVERAGE },
  };
}

export async function computeEnrichedOverviewMetrics(
  traces: TraceSummary[],
  caps: PhoenixCapabilities
): Promise<EnrichedOverviewMetrics> {
  if (traces.length === 0) {
    // Genuinely no traces in the selected window — distinct from
    // "telemetry unavailable" (available stays true; every count is a real
    // zero, and the rate-shaped fields say plainly that there was nothing
    // to compute a rate from).
    const emptyDist: DistributionResult = { data: {}, available: true, sampled: false, sampleSize: 0 };
    const zero = (): MetricResult<number> => ({ value: 0, available: true, sampled: false, sampleSize: 0 });
    const noObservations = (reason: string): MetricResult<number> => ({ value: null, available: true, sampled: false, sampleSize: 0, unavailableReason: reason });
    return {
      routeDistribution: emptyDist,
      modelDistribution: { ...emptyDist },
      memory: { hits: zero(), misses: zero(), lookupFailures: zero(), notAttempted: zero(), hitRate: noObservations('No traces in this period') },
      zeroRetrievalCount: { ...noObservations('No traces in this period'), attemptedCount: 0 },
      fallbackCount: zero(),
      fallbackBreakdown: { value: { retrieval: 0, emptySelectedChunks: 0, errorRecovery: 0, lectureUnavailable: 0, other: 0 }, available: true, sampled: false, sampleSize: 0 },
      telemetryCoverage: { ...ZERO_COVERAGE },
    };
  }

  if (!caps.supportsSpanTraceIdFiltering) {
    return unavailableEnrichedMetrics(
      caps.details.spanTraceIdFiltering?.state === 'unreachable'
        ? 'Phoenix is temporarily unreachable, so this metric could not be enriched this cycle.'
        : "This Phoenix server/client doesn't support filtering spans by trace ID, which this metric requires — Phoenix's trace summary response alone doesn't include span attributes."
    );
  }

  // `traces` is already sorted most-recent-first (getTraces was called with
  // sort: 'start_time', order: 'desc', and .filter() preserves order).
  const sampleTraces = traces.slice(0, ENRICHMENT_SAMPLE_LIMIT);
  const sampleTraceIds = sampleTraces.map(t => t.traceId);

  try {
    // The ONE batched Phoenix call every metric below is derived from —
    // see the module comment above for why this must never become N calls.
    const enrichResult = await withPhoenixRetry(() => getSpans({
      client: getPhoenixClient(),
      project: phoenixProject(),
      traceIds: sampleTraceIds,
      limit: ENRICHMENT_SPAN_FETCH_LIMIT,
    }));

    const rawSpans = enrichResult.spans as unknown as RawPhoenixSpan[];
    const byTrace = new Map<string, RawPhoenixSpan[]>();
    for (const raw of rawSpans) {
      const tid = raw.context?.trace_id;
      if (!tid) continue; // defensive — getSpans's full shape always carries context, unlike the embedded TraceSpanData shape
      if (!byTrace.has(tid)) byTrace.set(tid, []);
      byTrace.get(tid)!.push(raw);
    }

    const routeCounts: Record<string, number> = {};
    const modelCounts: Record<string, number> = {};
    const enrichedSummaries: TraceSummary[] = [];
    for (const traceId of sampleTraceIds) {
      const rawForTrace = byTrace.get(traceId);
      if (!rawForTrace || rawForTrace.length === 0) continue; // no spans came back for this trace this cycle — skip rather than guess
      const spans = rawForTrace.map(s => mapPhoenixSpan(s, traceId));
      const root = spans.find(s => !s.parentId) ?? spans[0];
      const summary = extractTraceSummary(traceId, root, spans);
      enrichedSummaries.push(summary);

      const routeKey = summary.route ?? 'unknown';
      routeCounts[routeKey] = (routeCounts[routeKey] ?? 0) + 1;

      for (const llm of spans.filter(s => s.kind === 'LLM')) {
        const modelKey = llm.model ?? 'unknown';
        modelCounts[modelKey] = (modelCounts[modelKey] ?? 0) + 1;
      }
    }

    const sampled = sampleTraceIds.length < traces.length;
    const sampleSize = enrichedSummaries.length;
    const { count: fallbackCount, breakdown: fallbackBreakdown } = computeFallbackMetrics(enrichedSummaries, sampled, sampleSize);
    const eligibleTraces = enrichedSummaries.filter(s => s.schemaVersion === OBSERVABILITY_SCHEMA_VERSION).length;
    const telemetryCoverage: TelemetryCoverage = {
      totalTraces: enrichedSummaries.length,
      eligibleTraces,
      legacyOrIncompleteTraces: enrichedSummaries.length - eligibleTraces,
    };

    return {
      routeDistribution: { data: routeCounts, available: true, sampled, sampleSize },
      modelDistribution: { data: modelCounts, available: true, sampled, sampleSize },
      memory: computeMemoryMetrics(enrichedSummaries, sampled, sampleSize),
      zeroRetrievalCount: computeZeroRetrievalMetric(enrichedSummaries, sampled, sampleSize),
      fallbackCount,
      fallbackBreakdown,
      telemetryCoverage,
    };
  } catch (err) {
    return unavailableEnrichedMetrics(`Enrichment request failed: ${(err as Error).message.slice(0, 150)}`);
  }
}

interface CacheEntry { value: OverviewResult; expiresAt: number }
const overviewCache = new Map<string, CacheEntry>();

export interface OverviewResult {
  metrics: OverviewMetrics;
  coveredTraceCount: number;
  truncated: boolean; // true if more traces existed in range than OVERVIEW_TRACE_LIMIT
}

export async function computeOverview(filters: OverviewFilters): Promise<OverviewResult> {
  const cacheKey = JSON.stringify(filters);
  const cached = overviewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const caps = await getPhoenixCapabilities();
  if (!caps.reachable) throw new ObservabilityError('PHOENIX_UNREACHABLE', 'Phoenix server is unreachable');
  if (!caps.supportsTraceListing) throw new ObservabilityError('PHOENIX_UNSUPPORTED_FEATURE', 'This Phoenix server version does not support trace listing');

  const result = await withPhoenixRetry(() => getTraces({
    client: getPhoenixClient(),
    project: phoenixProject(),
    startTime: filters.startTime ?? undefined,
    endTime: filters.endTime ?? undefined,
    sort: 'start_time',
    order: 'desc',
    limit: OVERVIEW_TRACE_LIMIT,
    includeSpans: true,
    sessionId: filters.sessionId ?? undefined,
  }));

  let traces: TraceSummary[] = result.traces.map(t => {
    const rawSpans = (t.spans ?? []) as unknown as RawPhoenixSpan[];
    const spans = rawSpans.map(s => mapPhoenixSpan(s, t.trace_id));
    const root = spans.find(s => !s.parentId) ?? spans[0] ?? null;
    return extractTraceSummary(t.trace_id, root, spans, {
      durationMs: new Date(t.end_time).getTime() - new Date(t.start_time).getTime(),
      timestamp: t.start_time,
      cumulativeTokens: { prompt: t.token_count_prompt ?? null, completion: t.token_count_completion ?? null, total: t.token_count_total ?? null },
    });
  });

  const allSpans = result.traces.flatMap(t => ((t.spans ?? []) as unknown as RawPhoenixSpan[]).map(s => mapPhoenixSpan(s, t.trace_id)));

  if (filters.lectureId) traces = traces.filter(t => t.lectureId === filters.lectureId);
  if (filters.route) traces = traces.filter(t => t.route === filters.route);
  if (filters.status) traces = traces.filter(t => t.status.toUpperCase() === filters.status!.toUpperCase());
  if (filters.environment) traces = traces.filter(t => t.environment === filters.environment);

  const includedTraceIds = new Set(traces.map(t => t.traceId));
  const spansInScope = allSpans.filter(s => includedTraceIds.has(s.traceId));

  const latencies = traces.map(t => t.durationMs).sort((a, b) => a - b);
  const successCount = traces.filter(t => t.status === 'SUCCESS' || t.status === 'OK').length;
  const failedCount = traces.filter(t => t.status === 'ERROR').length;

  const llmSpans = spansInScope.filter(s => s.kind === 'LLM');
  const retrievalSpans = spansInScope.filter(s => s.kind === 'RETRIEVER');
  const rerankerSpans = spansInScope.filter(s => s.kind === 'RERANKER');

  // Memory hit/miss, zero-retrieval, and fallback all read attributes
  // (memoryResult/candidateCount/notFoundReason) that only exist on the
  // enriched (getSpans-fetched) span shape — `traces` here is built from
  // getTraces({includeSpans:true}), whose embedded spans carry NO
  // attributes at all (see RawPhoenixSpan's comment). Computing these from
  // `traces` directly would silently read every attribute as null/absent
  // and report flat zeroes for 100% of the data — the exact bug this task
  // fixes. They're computed below from computeEnrichedOverviewMetrics's
  // single batched getSpans() result instead, same as route/model.

  const totalPromptTokens = traces.reduce((s, t) => s + (t.promptTokens ?? 0), 0);
  const totalCompletionTokens = traces.reduce((s, t) => s + (t.completionTokens ?? 0), 0);
  const totalTokens = traces.reduce((s, t) => s + (t.totalTokens ?? 0), 0);

  const countBy = <T,>(items: T[], key: (item: T) => string | null): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const item of items) {
      const k = key(item) ?? 'unknown';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  const spanDurationByName = new Map<string, number[]>();
  for (const s of spansInScope) {
    if (!spanDurationByName.has(s.name)) spanDurationByName.set(s.name, []);
    spanDurationByName.get(s.name)!.push(s.durationMs);
  }
  const slowestOperations = Array.from(spanDurationByName.entries())
    .map(([name, durations]) => ({ name, avgDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length, count: durations.length }))
    .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
    .slice(0, 10);

  const errorCounts = new Map<string, number>();
  for (const t of traces) {
    if (t.errorCode) errorCounts.set(t.errorCode, (errorCounts.get(t.errorCode) ?? 0) + 1);
  }
  const mostFrequentErrors = Array.from(errorCounts.entries())
    .map(([errorCode, count]) => ({ errorCode, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const { routeDistribution, modelDistribution, memory, zeroRetrievalCount, fallbackCount, fallbackBreakdown, telemetryCoverage } =
    await computeEnrichedOverviewMetrics(traces, caps);

  const metrics: OverviewMetrics = {
    range: {
      startTime: filters.startTime ?? traces[traces.length - 1]?.timestamp ?? new Date(0).toISOString(),
      endTime: filters.endTime ?? traces[0]?.timestamp ?? new Date().toISOString(),
    },
    totalTraces: traces.length,
    successfulTraces: successCount,
    failedTraces: failedCount,
    successRate: traces.length > 0 ? successCount / traces.length : 0,
    errorRate: traces.length > 0 ? failedCount / traces.length : 0,
    latencyMs: {
      avg: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      median: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      min: latencies[0] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
    },
    totalSpans: spansInScope.length,
    avgSpansPerTrace: traces.length > 0 ? spansInScope.length / traces.length : 0,
    tokens: {
      prompt: totalPromptTokens,
      completion: totalCompletionTokens,
      total: totalTokens,
      avgPerRequest: traces.length > 0 ? totalTokens / traces.length : 0,
    },
    llmCallCount: llmSpans.length,
    retrievalCallCount: retrievalSpans.length,
    rerankerCallCount: rerankerSpans.length,
    memory,
    zeroRetrievalCount,
    fallbackCount,
    fallbackBreakdown,
    telemetryCoverage,
    routeDistribution,
    statusDistribution: countBy(traces, t => t.status),
    spanKindDistribution: countBy(spansInScope, s => s.kind),
    modelDistribution,
    slowestOperations,
    mostFrequentErrors,
    timeSeries: buildTimeSeries(traces),
  };

  const value: OverviewResult = {
    metrics,
    coveredTraceCount: traces.length,
    truncated: result.traces.length >= OVERVIEW_TRACE_LIMIT,
  };
  overviewCache.set(cacheKey, { value, expiresAt: Date.now() + env.OBSERVABILITY.PHOENIX_OVERVIEW_CACHE_TTL_MS });
  return value;
}
