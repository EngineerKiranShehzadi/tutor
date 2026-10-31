import { env } from '../../../config/env';
import { DEFAULT_MIN_RERANK_SCORE } from '../../../services/rerank.service';
import { getActiveTrace } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import {
  retrieveForSubquery,
  mergeAndSelectWithCoverage,
  SINGLE_QUERY_CONTEXT_CHUNKS,
} from '../retrieval/decomposed-retrieval.service';
import type {
  RetrievalGroup,
  SubqueryRetrievalDeps,
  SubqueryRetrievalOutcome,
} from '../retrieval/decomposed-retrieval.service';
import { planAdaptiveRetrieval } from './adaptive-retrieval-planner.service';
import type {
  AdaptiveIterationRecord,
  AdaptiveRetrievalResult,
  AdaptiveRetrievalStopReason,
} from './adaptive-retrieval.types';

// Only ever called when Selective Subquery Decomposition's existing
// deterministic coverage signal already found a real gap (see
// chat.service.ts — it only calls this when uncoveredSubqueryIndexes is
// non-empty). This service does NOT re-run decomposition, does NOT invent
// new subtopics, and does NOT broaden retrieval beyond the aspects the
// student's own effective question already implied — it makes at most
// MAX_ITERATIONS targeted, bounded retrieval attempts for the SPECIFIC
// missing aspect(s) decomposition already identified.
const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

function toResult(
  triggered: boolean,
  iterations: AdaptiveIterationRecord[],
  stopReason: AdaptiveRetrievalStopReason,
  groups: RetrievalGroup[],
  coveredIndexes: number[],
  uncoveredIndexes: number[],
  desiredCount: number
): AdaptiveRetrievalResult {
  const { selectedChunks } = mergeAndSelectWithCoverage(groups, coveredIndexes, desiredCount);
  return {
    triggered,
    iterations,
    stopReason,
    coveredSubqueryIndexes: coveredIndexes,
    uncoveredSubqueryIndexes: uncoveredIndexes,
    selectedChunks,
  };
}

type IterationOutcome =
  | { ok: true; record: AdaptiveIterationRecord; groups: RetrievalGroup[]; coveredIndexes: number[]; uncoveredIndexes: number[] }
  | { ok: false; record: AdaptiveIterationRecord; stopReason: AdaptiveRetrievalStopReason };

// Runs exactly one bounded iteration: plan -> validate -> retrieve ->
// detect progress -> merge. Never throws — every failure mode becomes a
// typed stop reason instead.
async function runOneIteration(
  iteration: number,
  effectiveQuery: string,
  subqueries: string[],
  lectureId: number,
  groups: RetrievalGroup[],
  coveredIndexes: number[],
  uncoveredIndexes: number[],
  attemptedQueries: Set<string>,
  deps: SubqueryRetrievalDeps
): Promise<IterationOutcome> {
  const uncoveredAspectTexts = uncoveredIndexes.map(i => subqueries[i]);
  const plannerOutcome = await planAdaptiveRetrieval({
    effectiveQuery,
    uncoveredAspects: uncoveredAspectTexts,
    attemptedQueries: Array.from(attemptedQueries),
  });

  if (!plannerOutcome.ok) {
    return {
      ok: false,
      stopReason: plannerOutcome.failureReason,
      record: { iteration, action: 'FAILED', newChunkCount: 0, reason: `Planner failed: ${plannerOutcome.failureReason}` },
    };
  }

  const { plan } = plannerOutcome;
  if (plan.action === 'STOP') {
    return {
      ok: false,
      stopReason: 'PLANNER_STOPPED',
      record: { iteration, action: 'STOP', newChunkCount: 0, reason: plan.reason },
    };
  }

  const retrievalQuery = plan.retrievalQuery!;
  const normalizedQuery = normalize(retrievalQuery);
  if (attemptedQueries.has(normalizedQuery)) {
    return {
      ok: false,
      stopReason: 'DUPLICATE_RETRIEVAL_QUERY',
      record: {
        iteration, action: 'RETRIEVE', targetAspect: plan.targetAspect, retrievalQuery, newChunkCount: 0,
        reason: 'Proposed query duplicates an already-attempted retrieval query.',
      },
    };
  }
  attemptedQueries.add(normalizedQuery);

  // Match the planner's echoed targetAspect back to the uncovered subquery
  // it targets. Only when exactly one aspect is uncovered can a missing or
  // reworded echo safely fall back to it; with two or more, guessing would
  // credit evidence fetched for aspect B to aspect A, which then drops out of
  // uncoveredAspects and gets answered from the model's own knowledge.
  const matched = uncoveredIndexes.find(i => normalize(subqueries[i]) === normalize(plan.targetAspect ?? ''));
  const targetIndex = matched ?? (uncoveredIndexes.length === 1 ? uncoveredIndexes[0] : undefined);
  if (targetIndex === undefined) {
    return {
      ok: false,
      stopReason: 'INVALID_PLAN',
      record: {
        iteration, action: 'FAILED', targetAspect: plan.targetAspect, retrievalQuery, newChunkCount: 0,
        reason: 'Planner targetAspect did not match any uncovered aspect.',
      },
    };
  }

  const retrievalOutcome: SubqueryRetrievalOutcome = await retrieveForSubquery(targetIndex, retrievalQuery, lectureId, deps);

  const existingIds = new Set(groups.flatMap(g => g.reranked.map(c => c.id)));
  const newQualifying = retrievalOutcome.reranked.filter(
    c => (c.rerankScore ?? 0) >= DEFAULT_MIN_RERANK_SCORE && !existingIds.has(c.id)
  );

  if (!retrievalOutcome.covered || newQualifying.length === 0) {
    return {
      ok: false,
      stopReason: 'NO_NEW_EVIDENCE',
      record: {
        iteration, action: 'RETRIEVE', targetAspect: plan.targetAspect, retrievalQuery, newChunkCount: 0,
        reason: 'Targeted retrieval returned no new qualifying evidence.',
      },
    };
  }

  const nextGroups = groups.map(g =>
    g.index === targetIndex ? { index: targetIndex, reranked: [...g.reranked, ...retrievalOutcome.reranked] } : g
  );

  return {
    ok: true,
    groups: nextGroups,
    coveredIndexes: Array.from(new Set([...coveredIndexes, targetIndex])),
    uncoveredIndexes: uncoveredIndexes.filter(i => i !== targetIndex),
    record: { iteration, action: 'RETRIEVE', targetAspect: plan.targetAspect, retrievalQuery, newChunkCount: newQualifying.length, reason: plan.reason },
  };
}

export interface AdaptiveRetrievalParams {
  // The same effective self-contained query decomposition itself operated
  // on — adaptive retrieval never re-derives or broadens this.
  effectiveQuery: string;
  lectureId: number;
  subqueries: string[];
  // Decomposed retrieval's own per-subquery outcomes — reused as the
  // starting evidence set instead of re-retrieving anything already known.
  perSubquery: SubqueryRetrievalOutcome[];
  coveredSubqueryIndexes: number[];
  uncoveredSubqueryIndexes: number[];
  desiredCount?: number;
}

// Bounded iterative retrieval. Each iteration asks the planner for exactly
// ONE targeted retrieval query (or STOP), runs it through the existing
// single-query embed -> vector-search -> rerank pipeline (retrieveForSubquery
// — the identical function decomposed retrieval itself uses, so thresholds/
// lecture-scope/reranker are all unchanged), and merges qualifying new
// evidence back in via the same coverage-aware selection decomposed
// retrieval uses (mergeAndSelectWithCoverage). Stops on sufficient
// evidence, max iterations, planner STOP/failure, a duplicate proposed
// query, or no new evidence — never loops uncontrolled.
export async function runAdaptiveRetrieval(
  params: AdaptiveRetrievalParams,
  deps: SubqueryRetrievalDeps
): Promise<AdaptiveRetrievalResult> {
  // chat.service.ts passes the same decomposedContextBudget() the decomposed
  // retrieval used, so adaptive merging never shrinks the budget.
  const { effectiveQuery, lectureId, subqueries, perSubquery, desiredCount = SINGLE_QUERY_CONTEXT_CHUNKS } = params;
  const initialGroups: RetrievalGroup[] = subqueries.map((_, index) => ({
    index,
    reranked: perSubquery[index]?.reranked ?? [],
  }));

  const run = async (): Promise<AdaptiveRetrievalResult> => {
    if (!env.ADAPTIVE_RETRIEVAL.ENABLED || params.uncoveredSubqueryIndexes.length === 0) {
      return toResult(
        false, [], 'NO_MISSING_ASPECT',
        initialGroups, params.coveredSubqueryIndexes, params.uncoveredSubqueryIndexes, desiredCount
      );
    }

    let groups = initialGroups;
    let coveredIndexes = [...params.coveredSubqueryIndexes];
    let uncoveredIndexes = [...params.uncoveredSubqueryIndexes];
    // Seeded with the original subqueries too — the planner must never
    // "retarget" by proposing a query identical to one decomposition
    // already tried and found nothing for.
    const attemptedQueries = new Set(subqueries.map(normalize));
    const iterations: AdaptiveIterationRecord[] = [];
    const maxIterations = env.ADAPTIVE_RETRIEVAL.MAX_ITERATIONS;
    let stopReason: AdaptiveRetrievalStopReason = 'MAX_ITERATIONS_REACHED';

    const trace = getActiveTrace();

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (uncoveredIndexes.length === 0) {
        stopReason = 'SUFFICIENT_EVIDENCE';
        break;
      }

      const iterationArgs = [iteration, effectiveQuery, subqueries, lectureId, groups, coveredIndexes, uncoveredIndexes, attemptedQueries, deps] as const;
      const outcome: IterationOutcome = trace
        ? await trace.span(
            'adaptive-retrieval-iteration',
            () => runOneIteration(...iterationArgs),
            r => ({
              iteration,
              action: r.record.action,
              targetAspect: r.record.targetAspect ?? null,
              retrievalQuery: r.record.retrievalQuery ?? null,
              newChunkCount: r.record.newChunkCount,
              reason: r.record.reason,
            })
          )
        : await runOneIteration(...iterationArgs);

      iterations.push(outcome.record);

      if (!outcome.ok) {
        stopReason = outcome.stopReason;
        break;
      }
      groups = outcome.groups;
      coveredIndexes = outcome.coveredIndexes;
      uncoveredIndexes = outcome.uncoveredIndexes;
    }

    // Covers the case where the loop's last allowed iteration closed the
    // final gap — the for-loop then exits without re-checking at the top.
    if (uncoveredIndexes.length === 0) stopReason = 'SUFFICIENT_EVIDENCE';

    logger.info(
      `[ADAPTIVE-RETRIEVAL] ${iterations.length} iteration(s), stopReason=${stopReason}, covered=${coveredIndexes.length}/${subqueries.length}`
    );

    return toResult(true, iterations, stopReason, groups, coveredIndexes, uncoveredIndexes, desiredCount);
  };

  const trace = getActiveTrace();
  if (!trace) return run();
  return trace.span(
    'adaptive-retrieval',
    run,
    r => ({
      'adaptive_retrieval.enabled': env.ADAPTIVE_RETRIEVAL.ENABLED,
      'adaptive_retrieval.triggered': r.triggered,
      'adaptive_retrieval.iteration': r.iterations.length,
      'adaptive_retrieval.max_iterations': env.ADAPTIVE_RETRIEVAL.MAX_ITERATIONS,
      'adaptive_retrieval.stop_reason': r.stopReason,
      'adaptive_retrieval.covered_before': params.coveredSubqueryIndexes.length,
      'adaptive_retrieval.covered_after': r.coveredSubqueryIndexes.length,
      'adaptive_retrieval.new_chunk_count': r.iterations.reduce((sum, it) => sum + it.newChunkCount, 0),
    })
  );
}
