import type { QnaChunk } from '../../../types';
import type { NotFoundReason } from '../../../observability/types';
import { dedupeAndSelect, DEFAULT_MIN_RERANK_SCORE } from '../../../services/rerank.service';
import { getActiveTrace } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { env } from '../../../config/env';

// Same candidate pool size as the existing single-query path
// (chat.service.ts's CANDIDATE_LIMIT) — decomposition changes how many
// retrieval passes run, not how wide each one searches.
const SUBQUERY_CANDIDATE_LIMIT = 15;

export interface SubqueryRetrievalDeps {
  generateEmbedding: (text: string, isQuery?: boolean) => Promise<number[]>;
  searchChunks: (embedding: number[], lectureId: number, limit: number) => Promise<QnaChunk[]>;
  rerankChunks: (query: string, candidates: QnaChunk[], topN?: number) => Promise<QnaChunk[]>;
}

export interface SubqueryRetrievalOutcome {
  index: number;
  subquery: string;
  candidateCount: number;
  reranked: QnaChunk[]; // full reranked pool for this subquery, unfiltered, best-first
  covered: boolean;     // at least one reranked chunk meets the existing relevance floor
  failureReason?: 'NO_VECTOR_CANDIDATES' | 'ALL_BELOW_RERANK_FLOOR' | 'RETRIEVAL_ERROR';
  // Set only with RETRIEVAL_ERROR: the step that threw.
  failedStage?: 'EMBEDDING' | 'VECTOR_SEARCH' | 'RERANK';
}

// Runs the existing embed -> vector-search -> rerank pipeline for exactly
// one subquery, using the same clients/thresholds the single-query path
// uses (searchChunks already enforces SIMILARITY_THRESHOLD internally).
// Never throws — a transient failure on one subquery (embedding/search/
// rerank server hiccup) must not take down the other subqueries or the
// whole request; it just counts as uncovered, same as a genuine
// no-evidence result.
//
// Exported so adaptive-retrieval.service.ts can run exactly this same
// pipeline for a single planner-proposed targeted query, instead of
// duplicating embed/search/rerank wiring — a targeted adaptive query is
// architecturally just one more subquery, retrieved the same way.
export async function retrieveForSubquery(
  index: number,
  subquery: string,
  lectureId: number,
  deps: SubqueryRetrievalDeps
): Promise<SubqueryRetrievalOutcome> {
  const run = async (): Promise<SubqueryRetrievalOutcome> => {
    let stage: NonNullable<SubqueryRetrievalOutcome['failedStage']> = 'EMBEDDING';
    try {
      const embedding = await deps.generateEmbedding(subquery, true);
      stage = 'VECTOR_SEARCH';
      const candidates = await deps.searchChunks(embedding, lectureId, SUBQUERY_CANDIDATE_LIMIT);
      if (candidates.length === 0) {
        return { index, subquery, candidateCount: 0, reranked: [], covered: false, failureReason: 'NO_VECTOR_CANDIDATES' };
      }

      stage = 'RERANK';
      const reranked = await deps.rerankChunks(subquery, candidates, candidates.length);
      const covered = reranked.some(c => (c.rerankScore ?? 0) >= DEFAULT_MIN_RERANK_SCORE);
      return {
        index, subquery, candidateCount: candidates.length, reranked, covered,
        failureReason: covered ? undefined : 'ALL_BELOW_RERANK_FLOOR',
      };
    } catch (err) {
      logger.warn(`[QUERY-DECOMPOSITION] ⚠️  Subquery ${index} retrieval failed at ${stage}, treating as uncovered: ${(err as Error).message}`);
      return { index, subquery, candidateCount: 0, reranked: [], covered: false, failureReason: 'RETRIEVAL_ERROR', failedStage: stage };
    }
  };

  const trace = getActiveTrace();
  if (!trace) return run();
  return trace.span(
    'subquery-retrieval',
    run,
    r => ({
      subqueryIndex: r.index,
      candidateCount: r.candidateCount,
      rerankedCount: r.reranked.length,
      covered: r.covered,
      topRerankScore: r.reranked[0]?.rerankScore ?? null,
      failureReason: r.failureReason ?? null,
      failedStage: r.failedStage ?? null,
    })
  );
}

const FAILURE_REASON_BY_STAGE: Record<NonNullable<SubqueryRetrievalOutcome['failedStage']>, NotFoundReason> = {
  EMBEDDING: 'EMBEDDING_FAILURE',
  VECTOR_SEARCH: 'VECTOR_SEARCH_FAILURE',
  RERANK: 'RERANKER_FAILURE',
};

// Decides what a decomposed query that ended with ZERO selected chunks means,
// using the same rule as the single-query path:
//   - no evidence was found and every lookup ran -> NOT_FOUND, with the
//     observed reason (all NO_VECTOR_CANDIDATES -> NO_VECTOR_CANDIDATES,
//     otherwise ALL_CANDIDATES_BELOW_RERANK_FLOOR);
//   - any subquery's lookup failed (embed/search/rerank threw) -> ERROR,
//     with the failure reason of the first failed subquery. "Not in this
//     lecture" can't be claimed for a part that was never searched, and the
//     single-query path errors on the same failure.
export function classifyEmptyDecomposedResult(
  perSubquery: SubqueryRetrievalOutcome[]
): { outcome: 'NOT_FOUND' | 'ERROR'; reason: NotFoundReason } {
  const failed = perSubquery.find(r => r.failureReason === 'RETRIEVAL_ERROR');
  if (failed) return { outcome: 'ERROR', reason: FAILURE_REASON_BY_STAGE[failed.failedStage ?? 'EMBEDDING'] };
  const allNoCandidates = perSubquery.length > 0 && perSubquery.every(r => r.failureReason === 'NO_VECTOR_CANDIDATES');
  return { outcome: 'NOT_FOUND', reason: allNoCandidates ? 'NO_VECTOR_CANDIDATES' : 'ALL_CANDIDATES_BELOW_RERANK_FLOOR' };
}

// Deterministic, coverage-preserving cap to `desiredCount` slots:
//   pass 1 — one representative per covered subquery (in subquery order),
//            so no subquery with real evidence gets crowded out entirely;
//   pass 2 — fill any remaining slots with the next-best remaining
//            candidates overall, by rerank score.
// Intentionally simple — not an optimizer, just "guarantee coverage, then
// take the best of what's left".
function selectWithCoverage(
  dedupedFloor: QnaChunk[],
  provenance: Map<number, number[]>,
  coveredSubqueryIndexes: number[],
  desiredCount: number
): QnaChunk[] {
  const selected: QnaChunk[] = [];
  const selectedIds = new Set<number>();

  for (const subqueryIndex of coveredSubqueryIndexes) {
    if (selected.length >= desiredCount) break;
    const representative = dedupedFloor.find(
      c => !selectedIds.has(c.id) && (provenance.get(c.id) ?? []).includes(subqueryIndex)
    );
    if (representative) {
      selected.push(representative);
      selectedIds.add(representative.id);
    }
  }

  for (const chunk of dedupedFloor) {
    if (selected.length >= desiredCount) break;
    if (selectedIds.has(chunk.id)) continue;
    selected.push(chunk);
    selectedIds.add(chunk.id);
  }

  return selected;
}

// One retrieval group's worth of reranked evidence, keyed by a stable
// index — a subquery index for decomposed retrieval, or the same index
// reused by adaptive-retrieval.service.ts when it adds a targeted query's
// evidence for that same aspect. Generic on purpose: merge/coverage
// selection only needs "which index found this chunk", not what kind of
// query produced it.
export interface RetrievalGroup {
  index: number;
  reranked: QnaChunk[];
}

// Merges any number of retrieval groups by stable chunk identity (a chunk
// found by more than one group becomes one candidate, keeping its
// best-scoring occurrence — never duplicated), reuses the existing
// answer-text/split-piece dedup + relevance floor, then applies
// coverage-aware final selection (one representative per covered index
// first, then best-remaining). Exported so adaptive-retrieval.service.ts
// can re-run exactly this same merge after adding a new group's evidence,
// instead of reimplementing it.
export function mergeAndSelectWithCoverage(
  groups: RetrievalGroup[],
  coveredIndexes: number[],
  desiredCount: number
): { selectedChunks: QnaChunk[]; mergedRankedAll: QnaChunk[] } {
  const merged = new Map<number, QnaChunk>();
  const provenance = new Map<number, number[]>();
  for (const group of groups) {
    for (const chunk of group.reranked) {
      const existing = merged.get(chunk.id);
      if (!existing || (chunk.rerankScore ?? 0) > (existing.rerankScore ?? 0)) {
        merged.set(chunk.id, chunk);
      }
      const matched = provenance.get(chunk.id) ?? [];
      matched.push(group.index);
      provenance.set(chunk.id, matched);
    }
  }
  const mergedRankedAll = Array.from(merged.values()).sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

  // Reuse the existing semantic-duplicate-answer dedup + relevance floor
  // uncapped (desiredCount = full pool) so it only does its real job here
  // — coverage-aware capping is a distinct pass, done next.
  const { selected: dedupedFloor } = dedupeAndSelect(mergedRankedAll, mergedRankedAll.length, DEFAULT_MIN_RERANK_SCORE);

  const selectedChunks = selectWithCoverage(dedupedFloor, provenance, coveredIndexes, desiredCount);
  return { selectedChunks, mergedRankedAll };
}

// The context budget a single (DIRECT) question gets — chat.service.ts's
// dedupeAndSelect(rankedAll, 5) and dedupeAndSelect's own default.
export const SINGLE_QUERY_CONTEXT_CHUNKS = 5;

// Final context budget for a decomposed question: CONTEXT_PER_SUBQUERY per
// subquery, capped at CONTEXT_MAX_CHUNKS, never below a single question's
// budget. Used for both decomposed and adaptive retrieval.
export function decomposedContextBudget(
  subqueryCount: number,
  perSubquery: number = env.QUERY_DECOMPOSITION.CONTEXT_PER_SUBQUERY,
  maxChunks: number = env.QUERY_DECOMPOSITION.CONTEXT_MAX_CHUNKS
): number {
  return Math.max(SINGLE_QUERY_CONTEXT_CHUNKS, Math.min(perSubquery * subqueryCount, maxChunks));
}

export interface DecomposedRetrievalParams {
  lectureId: number;
  subqueries: string[];
  desiredCount?: number; // final context budget — chat.service.ts passes decomposedContextBudget(); defaults to the single-question 5
}

export interface DecomposedRetrievalResult {
  perSubquery: SubqueryRetrievalOutcome[];
  coveredSubqueryIndexes: number[];
  uncoveredSubqueryIndexes: number[];
  // Rerank-order, identity-deduped, coverage-selected final chunks — the
  // same shape/ordering convention the existing single-query path produces,
  // so chat.service.ts's citation/context-reorder handling downstream
  // doesn't need to know which path produced them.
  selectedChunks: QnaChunk[];
  totalCandidateCount: number;
}

// Fans out the existing retrieval pipeline across every subquery
// concurrently (bounded by the configured max subquery count — no
// additional concurrency control needed), then merges + coverage-selects
// via mergeAndSelectWithCoverage above.
export async function retrieveForDecomposedQuery(
  params: DecomposedRetrievalParams,
  deps: SubqueryRetrievalDeps
): Promise<DecomposedRetrievalResult> {
  const { lectureId, subqueries, desiredCount = SINGLE_QUERY_CONTEXT_CHUNKS } = params;

  const run = async (): Promise<DecomposedRetrievalResult> => {
    const perSubquery = await Promise.all(
      subqueries.map((subquery, index) => retrieveForSubquery(index, subquery, lectureId, deps))
    );

    const coveredSubqueryIndexes = perSubquery.filter(r => r.covered).map(r => r.index);
    const uncoveredSubqueryIndexes = perSubquery.filter(r => !r.covered).map(r => r.index);

    const { selectedChunks } = mergeAndSelectWithCoverage(
      perSubquery.map(r => ({ index: r.index, reranked: r.reranked })),
      coveredSubqueryIndexes,
      desiredCount
    );

    return {
      perSubquery,
      coveredSubqueryIndexes,
      uncoveredSubqueryIndexes,
      selectedChunks,
      totalCandidateCount: perSubquery.reduce((sum, r) => sum + r.candidateCount, 0),
    };
  };

  const trace = getActiveTrace();
  if (!trace) return run();
  return trace.span(
    'decomposed-retrieval',
    run,
    r => ({
      subqueryCount: subqueries.length,
      coveredSubqueryIndexes: r.coveredSubqueryIndexes.join(','),
      uncoveredSubqueryIndexes: r.uncoveredSubqueryIndexes.join(','),
      totalCandidateCount: r.totalCandidateCount,
      selectedChunkCount: r.selectedChunks.length,
      selectedChunkIds: r.selectedChunks.map(c => c.id).join(','),
    })
  );
}
