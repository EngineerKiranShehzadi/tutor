// Pure classification + aggregation logic for the Overview metrics that
// depend on full span ATTRIBUTES rather than Phoenix's cheap trace-list
// shape: memory hit/miss, zero-retrieval, and fallback usage. Kept separate
// from aggregate.service.ts (which owns the *fetching* — one batched
// getSpans() call reused for route/model distributions too, see that
// file's computeEnrichedOverviewMetrics) so this module can be unit tested
// against synthetic TraceSummary fixtures with no Phoenix client involved
// at all.
//
// Every value classified here originates from a root-span attribute set by
// chat.service.ts's trace.setAttributes(...)/finishTrace(...) calls and
// read back out by normalize.ts's extractTraceSummary — verified directly
// against chat.service.ts, not inferred:
//
//   attrs.memoryResult                -> TraceSummary.memoryResult    (string | null)
//   attrs.candidateCount              -> TraceSummary.retrievalCount   (number | null)
//   attrs.selectedChunkCount          -> TraceSummary.selectedChunkCount (number | null)
//   attrs.notFoundReason              -> TraceSummary.fallbackReason   (string | null)
//   attrs.route                       -> TraceSummary.route            (string | null)
//   attrs.observabilitySchemaVersion  -> TraceSummary.schemaVersion    (string | null)
//
// `memoryResult` real values (chat.service.ts, exhaustively grepped):
//   'NOT_ATTEMPTED'  — route isn't FACT_QUESTION (GREETING, LECTURE_SUMMARY,
//                       CONTEXTUAL_FOLLOW_UP never run the memory lookup)
//   'LOOKUP_FAILED'  — lookupAnswerMemory() threw
//   'EXACT_HIT'      — normalized-question exact match
//   'SEMANTIC_HIT'   — embedding-similarity match (only when
//                       RAG_MEMORY_SEMANTIC_ENABLED=true)
//   'MISS'           — lookup ran, found nothing
//   'ENTRY_CREATED'  — was 'MISS', then the post-answer memory WRITE
//                       succeeded (still a miss for hit/miss purposes — it
//                       describes what happened to the write, not the
//                       lookup outcome)
//   'WRITE_FAILED'   — was 'MISS', then the write failed (same as above:
//                       still a miss)
//
// There is currently no master "memory disabled" switch in this codebase
// (RAG_MEMORY.SEMANTIC_ENABLED only toggles the *semantic* sub-lookup;
// exact-match lookup always runs for FACT_QUESTION) — chat.service.ts never
// emits a 'DISABLED' memoryResult. The classifier still recognizes it
// (mapped to its own bucket, never folded into MISS) so this stays correct
// the moment such a flag is added, per the task's requirement to use real
// values while not hard-coding away a documented possible state.
//
// ── Telemetry coverage (this module's core safety property) ──────────────
// A missing attribute is data we don't have, not a negative measurement.
// Every classifier below distinguishes "attribute present, value known" from
// "attribute absent, coverage unknown" and every compute* function reports
// how many summaries fell into each bucket via the MetricResult coverage
// fields (eligibleSampleSize/incompleteSampleSize/partial/coveragePercent —
// see types.ts). A metric's headline `value` is derived ONLY from eligible
// traces; incomplete traces are excluded from both numerator and
// denominator, never coerced into "no event happened".
import { OBSERVABILITY_SCHEMA_VERSION } from '../../observability/types';
import type { FallbackBreakdown, MemoryMetrics, MetricResult, TraceSummary, ZeroRetrievalMetric } from './types';

function coverageFields(eligible: number, incomplete: number): { eligibleSampleSize: number; incompleteSampleSize: number; partial: boolean; coveragePercent: number } {
  const total = eligible + incomplete;
  return {
    eligibleSampleSize: eligible,
    incompleteSampleSize: incomplete,
    partial: incomplete > 0,
    // 100 when there was nothing to be incomplete about (total===0) —
    // callers must still check eligibleSampleSize/incompleteSampleSize
    // directly rather than reading coveragePercent alone in that case.
    coveragePercent: total > 0 ? Math.round((eligible / total) * 1000) / 10 : 100,
  };
}

// ── Memory classification ───────────────────────────────────────────────

export type MemoryClass = 'HIT' | 'MISS' | 'LOOKUP_FAILED' | 'NOT_ATTEMPTED' | 'DISABLED' | 'MISSING';

const MEMORY_HIT_VALUES = new Set(['EXACT_HIT', 'SEMANTIC_HIT']);
// MISS / ENTRY_CREATED / WRITE_FAILED are all "the lookup missed" — the
// latter two just additionally record the outcome of the write attempt
// that follows a miss. None of the three are a hit. Verified against
// chat.service.ts: ENTRY_CREATED/WRITE_FAILED only ever overwrite
// memoryResultAttr when it was already 'MISS' from a real lookupAnswerMemory()
// call (chat.service.ts's post-answer write block, guarded by
// `if (memoryResultAttr === 'MISS')`), and only for route === 'FACT_QUESTION'
// — neither value can be emitted when the lookup was skipped or failed.
const MEMORY_MISS_VALUES = new Set(['MISS', 'ENTRY_CREATED', 'WRITE_FAILED']);
const MEMORY_LOOKUP_FAILED_VALUES = new Set(['LOOKUP_FAILED']);
const MEMORY_NOT_ATTEMPTED_VALUES = new Set(['NOT_ATTEMPTED']);
const MEMORY_DISABLED_VALUES = new Set(['DISABLED']);

// `raw` is TraceSummary.memoryResult straight off the enriched root span.
// `null` (attribute absent from an otherwise-successfully-enriched trace —
// legacy trace, or a route/build that never set it) and any unrecognized
// string both classify as MISSING — deliberately never folded into
// MISS/NOT_ATTEMPTED, so malformed/legacy telemetry can never masquerade as
// a real measured outcome. computeMemoryMetrics below excludes MISSING from
// every bucket and reports it via the coverage fields instead.
export function classifyMemoryResult(raw: string | null): MemoryClass {
  if (raw === null) return 'MISSING';
  if (MEMORY_HIT_VALUES.has(raw)) return 'HIT';
  if (MEMORY_MISS_VALUES.has(raw)) return 'MISS';
  if (MEMORY_LOOKUP_FAILED_VALUES.has(raw)) return 'LOOKUP_FAILED';
  if (MEMORY_DISABLED_VALUES.has(raw)) return 'DISABLED';
  if (MEMORY_NOT_ATTEMPTED_VALUES.has(raw)) return 'NOT_ATTEMPTED';
  return 'MISSING';
}

const NO_COMPATIBLE_MEMORY_TELEMETRY =
  'No traces with compatible memory telemetry were found — older traces missing memoryResult were excluded, not counted as not-attempted.';

// `summaries` must already be the enriched (full-attribute) set — callers
// must NOT pass the cheap embedded-shape TraceSummary[] (attributes always
// {} there, so every memoryResult would read as MISSING and every count
// would silently be 0 without ever being "wrong" in an obviously-detectable
// way — this is exactly the bug this task fixes).
export function computeMemoryMetrics(summaries: TraceSummary[], sampled: boolean, sampleSize: number): MemoryMetrics {
  let hits = 0, misses = 0, lookupFailed = 0, notAttempted = 0, disabled = 0, missing = 0;
  for (const s of summaries) {
    switch (classifyMemoryResult(s.memoryResult)) {
      case 'HIT': hits++; break;
      case 'MISS': misses++; break;
      case 'LOOKUP_FAILED': lookupFailed++; break;
      case 'NOT_ATTEMPTED': notAttempted++; break;
      case 'DISABLED': disabled++; break;
      case 'MISSING': missing++; break; // never counted into any bucket below
    }
  }
  const eligible = hits + misses + lookupFailed + notAttempted + disabled;
  const coverage = coverageFields(eligible, missing);

  // Every enriched trace lacked memoryResult entirely — we have zero real
  // signal, not a real zero. Report unavailable rather than a fake "0 hits".
  if (eligible === 0 && missing > 0) {
    const unavailable = (): MetricResult<number> => ({
      value: null, available: false, sampled, sampleSize, ...coverage, unavailableReason: NO_COMPATIBLE_MEMORY_TELEMETRY,
    });
    return { hits: unavailable(), misses: unavailable(), lookupFailures: unavailable(), notAttempted: unavailable(), hitRate: unavailable() };
  }

  const base = { available: true as const, sampled, sampleSize, ...coverage };
  const denom = hits + misses;
  return {
    hits: { value: hits, ...base },
    misses: { value: misses, ...base },
    lookupFailures: { value: lookupFailed, ...base },
    // `disabled` isn't part of the MemoryMetrics shape (no consumer needs
    // it as its own KPI yet) but is deliberately tallied above rather than
    // silently dropped, in case a future master switch starts emitting it.
    notAttempted: { value: notAttempted, ...base },
    hitRate: denom > 0
      ? { value: hits / denom, ...base }
      // Data was fetched fine — there just were no completed hit/miss
      // lookups among the ELIGIBLE traces (e.g. every eligible trace was
      // NOT_ATTEMPTED/LOOKUP_FAILED/DISABLED). Division by zero is never
      // attempted.
      : { value: null, ...base, unavailableReason: 'No memory lookups in this period' },
  };
}

// ── Zero-retrieval classification ───────────────────────────────────────

// Routes that structurally never call vector-search (chat.service.ts:
// GREETING returns before any embedding/search call; LECTURE_SUMMARY uses
// getAllLectureChunks instead) — retrieval is genuinely not applicable, not
// merely unmeasured, for these.
const ROUTES_WITHOUT_RETRIEVAL = new Set(['GREETING', 'LECTURE_SUMMARY']);

export type RetrievalCoverageClass = 'ATTEMPTED' | 'NOT_APPLICABLE' | 'INCOMPLETE';

// A real candidateCount is always trusted on its own — its mere presence
// proves vector-search ran, regardless of what `route` says (route is a
// second, independent signal, not a prerequisite). Only when candidateCount
// is absent do we need `route` at all: a known skip-route means retrieval
// was genuinely never attempted (NOT_APPLICABLE); anything else (a
// retrieval-requiring route with no telemetry, or route itself unknown/
// missing — true legacy) means we cannot tell whether retrieval ran, so the
// trace is INCOMPLETE, not a non-attempt.
export function classifyRetrievalCoverage(route: string | null, retrievalCount: number | null): RetrievalCoverageClass {
  if (retrievalCount !== null) return 'ATTEMPTED';
  if (route !== null && ROUTES_WITHOUT_RETRIEVAL.has(route)) return 'NOT_APPLICABLE';
  return 'INCOMPLETE';
}

const NO_COMPATIBLE_RETRIEVAL_TELEMETRY =
  'No traces with compatible retrieval telemetry were found — older traces missing candidateCount were excluded, not counted as non-retrieval routes.';

export function computeZeroRetrievalMetric(summaries: TraceSummary[], sampled: boolean, sampleSize: number): ZeroRetrievalMetric {
  let attempted = 0, zero = 0, incomplete = 0;
  for (const s of summaries) {
    const cls = classifyRetrievalCoverage(s.route, s.retrievalCount);
    if (cls === 'ATTEMPTED') {
      attempted++;
      if (s.retrievalCount === 0) zero++;
    } else if (cls === 'INCOMPLETE') {
      incomplete++;
    }
    // NOT_APPLICABLE: correctly excluded from every count, not incomplete.
  }
  const coverage = coverageFields(attempted, incomplete);

  if (attempted === 0) {
    if (incomplete > 0) {
      // Traces existed that should have carried retrieval telemetry, but
      // none did — genuinely unknown, not "no retrieval attempts".
      return { value: null, available: false, sampled, sampleSize, ...coverage, attemptedCount: 0, unavailableReason: NO_COMPATIBLE_RETRIEVAL_TELEMETRY };
    }
    return { value: null, available: true, sampled, sampleSize, ...coverage, attemptedCount: 0, unavailableReason: 'No retrieval attempts in this period' };
  }
  return { value: zero, available: true, sampled, sampleSize, ...coverage, attemptedCount: attempted };
}

// ── Fallback classification ─────────────────────────────────────────────

// TraceSummary.fallbackReason is `attrs.notFoundReason ?? attrs.fallbackReason`
// (normalize.ts) — chat.service.ts only ever sets `notFoundReason`, and
// only on the paths documented at OBSERVABILITY_SCHEMA_VERSION's definition
// (hardcoded not-found answers + the three retrieval-stage failure modes).
// For a CURRENT-schema trace, `fallbackReason === null` is therefore a real
// "no fallback" signal. For a trace that does NOT carry the current schema
// marker, the same absence is ambiguous — it could be a genuine no-fallback
// trace, OR a legacy/partial exporter that never set notFoundReason on a
// real fallback. classifyFallbackEligibility below is what keeps those
// apart; computeFallbackMetrics excludes ineligible traces from the count
// entirely rather than reading their absence as "no fallback".
const RETRIEVAL_FALLBACK = new Set(['NO_VECTOR_CANDIDATES']);
const EMPTY_CHUNKS_FALLBACK = new Set(['ALL_CANDIDATES_BELOW_RERANK_FLOOR']);
const ERROR_RECOVERY_FALLBACK = new Set(['EMBEDDING_FAILURE', 'VECTOR_SEARCH_FAILURE', 'RERANKER_FAILURE']);
const LECTURE_UNAVAILABLE_FALLBACK = new Set(['EMPTY_LECTURE', 'SUMMARY_CONTENT_EMPTY']);

export function classifyFallbackReason(reason: string | null): keyof FallbackBreakdown | null {
  if (reason === null) return null;
  if (RETRIEVAL_FALLBACK.has(reason)) return 'retrieval';
  if (EMPTY_CHUNKS_FALLBACK.has(reason)) return 'emptySelectedChunks';
  if (ERROR_RECOVERY_FALLBACK.has(reason)) return 'errorRecovery';
  if (LECTURE_UNAVAILABLE_FALLBACK.has(reason)) return 'lectureUnavailable';
  return 'other'; // a real notFoundReason value this classifier hasn't been taught yet — still counted, never dropped
}

// Only a trace stamped with the CURRENT schema version is trusted to have
// `notFoundReason` reliably set whenever a fallback occurred. Anything else
// (no marker at all — every trace recorded before this audit — or a marker
// for a version this codebase no longer documents guarantees for) is
// INCOMPLETE for fallback purposes specifically, even if its other
// attributes (route, memoryResult, candidateCount) look perfectly normal.
export function classifyFallbackEligibility(schemaVersion: string | null): 'ELIGIBLE' | 'INCOMPLETE' {
  return schemaVersion === OBSERVABILITY_SCHEMA_VERSION ? 'ELIGIBLE' : 'INCOMPLETE';
}

const NO_COMPATIBLE_FALLBACK_TELEMETRY = 'No traces with compatible fallback telemetry were found';

export function computeFallbackMetrics(
  summaries: TraceSummary[],
  sampled: boolean,
  sampleSize: number
): { count: MetricResult<number>; breakdown: MetricResult<FallbackBreakdown> } {
  const breakdown: FallbackBreakdown = { retrieval: 0, emptySelectedChunks: 0, errorRecovery: 0, lectureUnavailable: 0, other: 0 };
  let total = 0, eligible = 0, incomplete = 0;
  for (const s of summaries) {
    if (classifyFallbackEligibility(s.schemaVersion) === 'INCOMPLETE') { incomplete++; continue; }
    eligible++;
    const cls = classifyFallbackReason(s.fallbackReason);
    if (cls) { breakdown[cls]++; total++; }
  }
  const coverage = coverageFields(eligible, incomplete);

  if (eligible === 0 && incomplete > 0) {
    const unavailable: MetricResult<number> = { value: null, available: false, sampled, sampleSize, ...coverage, unavailableReason: NO_COMPATIBLE_FALLBACK_TELEMETRY };
    return {
      count: unavailable,
      breakdown: { value: null, available: false, sampled, sampleSize, ...coverage, unavailableReason: NO_COMPATIBLE_FALLBACK_TELEMETRY },
    };
  }

  const base = { available: true as const, sampled, sampleSize, ...coverage };
  return { count: { value: total, ...base }, breakdown: { value: breakdown, ...base } };
}

// ── Shared "could not compute this at all" factory ──────────────────────

// Used by aggregate.service.ts for the three failure states that apply
// uniformly to every attribute-derived metric in one enrichment cycle:
// Phoenix unreachable, server/client lacking span trace-ID filtering, or
// the batched getSpans() request itself throwing. No coverage fields —
// nothing was classified because nothing could be fetched.
export function unavailableMetric<T>(reason: string): MetricResult<T> {
  return { value: null, available: false, sampled: false, sampleSize: 0, unavailableReason: reason };
}
