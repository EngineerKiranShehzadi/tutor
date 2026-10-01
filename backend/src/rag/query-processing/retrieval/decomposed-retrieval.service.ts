import type { QnaChunk } from '../../../types';
import { dedupeAndSelect, DEFAULT_MIN_RERANK_SCORE } from '../../../services/rerank.service';
import { getActiveTrace } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';

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
    try {
      const embedding = await deps.generateEmbedding(subquery, true);
      const candidates = await deps.searchChunks(embedding, lectureId, SUBQUERY_CANDIDATE_LIMIT);
      if (candidates.length === 0) {
        return { index, subquery, candidateCount: 0, reranked: [], covered: false, failureReason: 'NO_VECTOR_CANDIDATES' };
      }

      const reranked = await deps.rerankChunks(subquery, candidates, candidates.length);
      const covered = reranked.some(c => (c.rerankScore ?? 0) >= DEFAULT_MIN_RERANK_SCORE);
      return {
        index, subquery, candidateCount: candidates.length, reranked, covered,
        failureReason: covered ? undefined : 'ALL_BELOW_RERANK_FLOOR',
      };
    } catch (err) {
      logger.warn(`[QUERY-DECOMPOSITION] ⚠️  Subquery ${index} retrieval failed, treating as uncovered: ${(err as Error).message}`);
      return { index, subquery, candidateCount: 0, reranked: [], covered: false, failureReason: 'RETRIEVAL_ERROR' };
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
    })
  );
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

export interface DecomposedRetrievalParams {
  lectureId: number;
  subqueries: string[];
  desiredCount?: number; // final context budget — defaults to 5, matching the existing single-query dedupeAndSelect default
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
  const { lectureId, subqueries, desiredCount = 5 } = params;

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
