import type { QnaChunk } from '../../../types';

// The planner's only two possible decisions — it never answers the
// student's question, it only decides whether another targeted retrieval
// attempt is worthwhile.
export type AdaptiveRetrievalAction = 'STOP' | 'RETRIEVE';

// Stable stop-reason codes — same convention as the input guardrail's
// InputGuardrailReason and the decomposition layer's
// QueryDecompositionReason: every outcome is named, never left to free
// text, and infra failure is always distinguishable from a deliberate
// safety/policy decision.
export const ADAPTIVE_RETRIEVAL_STOP_REASONS = [
  'SUFFICIENT_EVIDENCE',        // no (more) uncovered aspects remain
  'MAX_ITERATIONS_REACHED',     // configured iteration budget exhausted with a gap still open
  'NO_MISSING_ASPECT',          // service was invoked but there was nothing to target (defensive/degenerate)
  'PLANNER_STOPPED',            // planner explicitly returned STOP
  'PLANNER_TIMEOUT',
  'PLANNER_ERROR',
  'INVALID_PLAN',               // structured output parsed but failed validation
  'DUPLICATE_RETRIEVAL_QUERY',  // planner proposed a query already attempted
  'NO_NEW_EVIDENCE',            // targeted retrieval ran but added nothing new
] as const;

export type AdaptiveRetrievalStopReason = typeof ADAPTIVE_RETRIEVAL_STOP_REASONS[number];

export interface AdaptiveRetrievalPlan {
  action: AdaptiveRetrievalAction;
  // Present only when action === 'RETRIEVE'.
  retrievalQuery?: string;
  targetAspect?: string;
  reason: string;
}

// Infra failure is not the same as a safety/policy result — callers must
// branch on `ok` before ever looking at `plan`.
export type AdaptivePlannerOutcome =
  | { ok: true; plan: AdaptiveRetrievalPlan }
  | { ok: false; failureReason: 'PLANNER_TIMEOUT' | 'PLANNER_ERROR' | 'INVALID_PLAN' };

// One bounded iteration's outcome — kept for observability and for the
// "already attempted" duplicate check, not persisted anywhere.
export interface AdaptiveIterationRecord {
  iteration: number;
  action: AdaptiveRetrievalAction | 'FAILED';
  targetAspect?: string;
  retrievalQuery?: string;
  newChunkCount: number;
  reason: string;
}

export interface AdaptiveRetrievalResult {
  // False when the service was never really invoked (disabled, or no
  // uncovered aspect to begin with) — chat.service.ts uses this to decide
  // whether to touch `chunks`/`uncoveredAspects` at all.
  triggered: boolean;
  iterations: AdaptiveIterationRecord[];
  stopReason: AdaptiveRetrievalStopReason;
  coveredSubqueryIndexes: number[];
  uncoveredSubqueryIndexes: number[];
  // Rerank-order, identity-deduped, coverage-selected final chunks —
  // includes both the original decomposed-retrieval evidence and any
  // qualifying adaptive evidence merged in. Same shape/ordering convention
  // as DecomposedRetrievalResult.selectedChunks.
  selectedChunks: QnaChunk[];
}
