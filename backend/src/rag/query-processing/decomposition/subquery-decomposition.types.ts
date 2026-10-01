// Answers a different question than the existing history rewriter
// (query-rewriter.service.ts): not "does this depend on prior
// conversation?" but "does this self-contained query contain multiple
// independent information needs that retrieval should search separately?"
export type QueryDecompositionMode = 'DIRECT' | 'DECOMPOSED';

// Stable reason codes — same convention as the input guardrail's
// InputGuardrailReason (rag/guardrails/input/types/input-guardrail-reasons.
// ts): every outcome is named, never left to free text.
export const QUERY_DECOMPOSITION_REASONS = [
  'NOT_COMPOUND',            // deterministic detector found no candidate signal — the common case, zero LLM calls
  'LLM_DECIDED_DIRECT',      // candidate signal found, but the LLM judged it one retrieval need
  'LLM_DECIDED_DECOMPOSE',
  'DECOMPOSITION_DISABLED',  // QUERY_DECOMPOSITION_ENABLED=false
  'CLASSIFIER_TIMEOUT',
  'CLASSIFIER_ERROR',
  'INVALID_SUBQUERY_LIST',  // structured output parsed but failed validation (empty/duplicate-only/etc.)
] as const;

export type QueryDecompositionReason = typeof QUERY_DECOMPOSITION_REASONS[number];

export interface SubqueryDecompositionResult {
  mode: QueryDecompositionMode;
  effectiveQuery: string;
  // Empty for DIRECT. 2..MAX_SUBQUERIES self-contained retrieval queries
  // for DECOMPOSED — never the parent query itself.
  subqueries: string[];
  reason: QueryDecompositionReason;
  // True iff the semantic decomposition call was actually attempted —
  // false when the deterministic gate alone was enough to decide DIRECT
  // (NOT_COMPOUND) or decomposition is disabled outright.
  llmUsed: boolean;
}

// Raw structured output the LLM is asked to return — validated and mapped
// into SubqueryDecompositionResult by subquery-decomposition.service.ts.
// Never exposed past that file.
export interface RawDecompositionDecision {
  decision: 'DIRECT' | 'DECOMPOSE';
  subqueries: string[];
  reason: string;
}
