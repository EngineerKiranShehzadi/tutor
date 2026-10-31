import type { ExpectedResponseFormat } from './format/response-format.types';
import type { PiiCategory } from '../shared/pii/pii.types';

// Post-generation groundedness verification — the output-side counterpart
// to rag/guardrails/input/. Judges an already-generated draft answer
// against the exact evidence the generator used; never a second retrieval
// pass (that's Iterative Adaptive Retrieval's job, and it already runs
// before generation).
export type AnswerVerificationDecision = 'VERIFIED' | 'REVISE' | 'INSUFFICIENT_EVIDENCE';

// Stable reason codes — same convention as every other guardrail/planning
// layer in this codebase (InputGuardrailReason, QueryDecompositionReason,
// AdaptiveRetrievalStopReason): every outcome is named, infra failure is
// always distinguishable from a deliberate safety/policy decision.
export const ANSWER_VERIFICATION_REASONS = [
  'VERIFIED',
  'UNSUPPORTED_CLAIMS',
  'CONTRADICTS_EVIDENCE',
  'ANSWERED_UNCOVERED_ASPECT',
  'INSUFFICIENT_EVIDENCE',
  'VERIFIER_TIMEOUT',
  'VERIFIER_PROVIDER_ERROR',
  'VERIFIER_INVALID_OUTPUT',
  'REVISION_FAILED',
  'FINAL_VERIFICATION_FAILED',
] as const;
export type AnswerVerificationReason = typeof ANSWER_VERIFICATION_REASONS[number];

// The verifier's own structured judgment — see answer-groundedness-
// verifier.service.ts. Never rewrites the answer itself.
export interface AnswerVerificationResult {
  decision: AnswerVerificationDecision;
  // Verbatim/near-verbatim phrases from the draft the verifier judged
  // unsupported — bounded, never arbitrary-length.
  unsupportedClaims: string[];
  // Aspects the draft answered despite being marked uncovered upstream, or
  // that the verifier otherwise judged unanswerable from the evidence.
  missingAspects: string[];
  reason: AnswerVerificationReason;
  // Short free-text explanation from the model, bounded/truncated — for
  // logs/observability only, never the basis for control flow.
  detail: string;
}

// Infra failure is not the same as a safety/policy result — callers must
// branch on `ok` before ever looking at `result`. Mirrors AdaptivePlannerOutcome
// in adaptive-retrieval.types.ts.
export type VerifierOutcome =
  | { ok: true; result: AnswerVerificationResult }
  | { ok: false; failureReason: 'VERIFIER_TIMEOUT' | 'VERIFIER_PROVIDER_ERROR' | 'VERIFIER_INVALID_OUTPUT' };

export type RevisionOutcome =
  | { ok: true; revisedAnswer: string }
  | { ok: false; failureReason: 'REVISION_FAILED' };

// output-guardrail.service.ts's own outcome vocabulary — a superset of
// AnswerVerificationReason covering the orchestration-level cases (feature
// disabled, revision failed, final re-verification failed) that aren't
// verifier decisions themselves.
export const OUTPUT_GUARDRAIL_REASONS = [
  ...ANSWER_VERIFICATION_REASONS,
  'VERIFICATION_DISABLED',
  'REVISED_AND_VERIFIED',
  'REVISED_BUT_UNVERIFIED',
] as const;
export type OutputGuardrailReason = typeof OUTPUT_GUARDRAIL_REASONS[number];

export interface OutputGuardrailResult {
  // The text that must actually be persisted/returned — either the
  // original draft (VERIFIED), a verified revision (REVISED_AND_VERIFIED),
  // a conservative grounded fallback (content decisions), or
  // VERIFICATION_UNAVAILABLE_MESSAGE when the verifier couldn't run. Never an
  // unverified draft (unless fail-open is explicitly enabled).
  finalAnswer: string;
  // True iff finalAnswer is a draft or revision that actually passed
  // verification — false whenever finalAnswer is a conservative fallback.
  verified: boolean;
  decision: AnswerVerificationDecision | null;
  reason: OutputGuardrailReason;
  revisionAttempted: boolean;
  revisionSucceeded: boolean;
  // True only when the verifier could not run (timeout, provider error,
  // invalid output, failed revision, failed final verification) and the
  // guardrail is failing closed. The answer is then neither served nor saved:
  // chat.service.ts reports a 503 "couldn't check this answer" error instead
  // of claiming the lecture doesn't cover the topic.
  verificationUnavailable: boolean;
  // Counts only, from whichever verification pass produced the final
  // decision — never the claim/aspect text itself, so this is always safe
  // to put directly into trace attributes.
  unsupportedClaimCount: number;
  missingAspectCount: number;

  // ── Selective Output Format Validation ──────────────────────────────
  // Populated by applyFormatAndPiiGuards() in output-guardrail.service.ts,
  // which runs after the groundedness/revision fields above are already
  // decided. NATURAL_TEXT/false/true defaults below describe "format
  // validation didn't apply" — most answers never need more than that.
  expectedFormat: ExpectedResponseFormat;
  formatValidationRequired: boolean;
  formatValid: boolean;
  formatRepairAttempted: boolean;
  formatRepairSucceeded: boolean;

  // ── Output PII Leakage Detection ────────────────────────────────────
  // Never the actual detected value(s) — only category labels, same
  // contract as OutputPiiGuardResult.
  piiDetected: boolean;
  piiCategories: PiiCategory[];
}
