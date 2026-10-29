import { env } from '../../../config/env';
import { getActiveTrace } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { verifyAnswerGroundedness } from './answer-groundedness-verifier.service';
import { reviseAnswer } from './answer-revision.service';
import { detectExpectedResponseFormat } from './format/response-format.detector';
import { validateResponseFormat } from './format/response-format.guard';
import { repairResponseFormat } from './format/response-format-repair.service';
import { detectOutputPiiLeakage } from './pii/output-pii-leakage.guard';
import type { ExpectedResponseFormat } from './format/response-format.types';
import type { OutputGuardrailResult, OutputGuardrailReason, AnswerVerificationDecision } from './answer-verification.types';

export interface OutputGuardrailParams {
  question: string;
  // The effective, self-contained query used for retrieval (chat.service.ts's
  // retrievalQuery — history-resolved, but otherwise the student's own
  // phrasing). Selective Output Format Validation reads its LIST/TABLE
  // signals from this, not from `question` — the two are usually the same
  // text, but retrievalQuery is the one already established elsewhere in
  // this codebase as "the effective query" (see decomposeQuery's
  // effectiveQuery param).
  effectiveQuery: string;
  // Same list chat.service.ts already threads into generateAnswer's
  // uncoveredAspects param — the aspects Selective Subquery Decomposition/
  // Iterative Adaptive Retrieval already determined have no evidence.
  uncoveredAspects: string[];
  // The exact chunk_text values supplied to the generator — not the whole
  // candidate pool, not raw QnaChunk rows.
  evidenceTexts: string[];
  draftAnswer: string;
  // Reused verbatim for a total-support-failure fallback — keeps the
  // conservative response consistent with the existing not-found wording
  // used everywhere else in chat.service.ts, instead of inventing new copy.
  notFoundMessage: string;
}

// Deterministic, never an LLM call — this only fires once we've already
// decided not to trust the draft, so it must not depend on anything we no
// longer trust either. Mirrors the existing not-found convention rather
// than inventing new wording: total lack of support reuses the exact
// existing message; partial coverage names the specific missing aspect(s)
// using the same "I could not find ... in this lecture" phrasing.
function conservativeFallback(params: OutputGuardrailParams): string {
  if (params.uncoveredAspects.length === 0) return params.notFoundMessage;
  return `I could not find enough information in this lecture to fully answer this — specifically: ${params.uncoveredAspects.join('; ')}.`;
}

function buildResult(args: {
  finalAnswer: string;
  verified: boolean;
  decision: AnswerVerificationDecision | null;
  reason: OutputGuardrailReason;
  revisionAttempted: boolean;
  revisionSucceeded: boolean;
  unsupportedClaimCount?: number;
  missingAspectCount?: number;
}): OutputGuardrailResult {
  return {
    finalAnswer: args.finalAnswer,
    verified: args.verified,
    decision: args.decision,
    reason: args.reason,
    revisionAttempted: args.revisionAttempted,
    revisionSucceeded: args.revisionSucceeded,
    unsupportedClaimCount: args.unsupportedClaimCount ?? 0,
    missingAspectCount: args.missingAspectCount ?? 0,
    // Overwritten by applyFormatAndPiiGuards() below once the groundedness
    // stage's result feeds into it — these defaults only describe "format/
    // PII didn't apply", so buildResult()'s own output is still a valid,
    // safe OutputGuardrailResult on its own.
    expectedFormat: 'NATURAL_TEXT',
    formatValidationRequired: false,
    formatValid: true,
    formatRepairAttempted: false,
    formatRepairSucceeded: false,
    piiDetected: false,
    piiCategories: [],
  };
}

// Runs after the groundedness/revision stage above has already decided
// finalAnswer — see this file's module doc for the full target flow.
// Deliberately independent of ANSWER_VERIFICATION.ENABLED: format and PII
// safety are separate concerns from hallucination detection and apply to
// whatever finalAnswer that stage produced, even when groundedness
// verification itself is turned off.
async function applyFormatAndPiiGuards(
  effectiveQuery: string,
  groundedness: OutputGuardrailResult,
  draftAnswer: string
): Promise<OutputGuardrailResult> {
  // Format validation only ever applies to real generated content. When the
  // groundedness stage fell back to its deterministic conservative message
  // (verified=false and it's not merely that verification is disabled),
  // that fallback is already safe static copy that was never asked to be a
  // list/table in the first place — reformatting an "I could not find
  // this..." apology would be pointless and could look like fabrication.
  // A fail-open draft is real generated content (unverified, but not a
  // static fallback), so it still gets format validation.
  const isFallbackAnswer = !groundedness.verified
    && groundedness.reason !== 'VERIFICATION_DISABLED'
    && groundedness.finalAnswer !== draftAnswer;

  let finalAnswer = groundedness.finalAnswer;
  let expectedFormat: ExpectedResponseFormat = 'NATURAL_TEXT';
  let formatValidationRequired = false;
  let formatValid = true;
  let formatRepairAttempted = false;
  let formatRepairSucceeded = false;

  if (env.OUTPUT_FORMAT_VALIDATION.ENABLED && !isFallbackAnswer) {
    expectedFormat = detectExpectedResponseFormat(effectiveQuery);

    if (expectedFormat !== 'NATURAL_TEXT') {
      formatValidationRequired = true;
      const validation = validateResponseFormat(expectedFormat, finalAnswer);
      formatValid = validation.valid;

      if (!validation.valid && env.OUTPUT_FORMAT_VALIDATION.REPAIR_ENABLED) {
        formatRepairAttempted = true;
        logger.info(`[OUTPUT-GUARDRAIL] 🔧 ${validation.reason} — attempting one bounded format repair (${expectedFormat})`);
        const repair = await repairResponseFormat(expectedFormat, finalAnswer);

        // Bounded to exactly one attempt either way — re-validate the
        // repaired text structurally and only trust it if it actually
        // produced the requested structure; otherwise keep the original
        // grounded (just unrestructured) answer rather than risk an
        // empty/malformed repair reaching the student.
        if (repair.ok && repair.repairedAnswer && validateResponseFormat(expectedFormat, repair.repairedAnswer).valid) {
          finalAnswer = repair.repairedAnswer;
          formatValid = true;
          formatRepairSucceeded = true;
        } else {
          logger.warn('[OUTPUT-GUARDRAIL] ⚠️  Format repair did not produce a valid structure — keeping original grounded answer');
        }
      }
    }
  }

  let piiDetected = false;
  let piiCategories: OutputGuardrailResult['piiCategories'] = [];
  if (env.OUTPUT_PII_GUARD.ENABLED) {
    const piiScan = detectOutputPiiLeakage(finalAnswer);
    piiDetected = piiScan.piiDetected;
    piiCategories = piiScan.detectedCategories;
    if (piiDetected) {
      logger.warn(`[OUTPUT-GUARDRAIL] 🛡️  PII detected in final answer (${piiCategories.join(', ')}) — sanitized before persistence`);
      finalAnswer = piiScan.sanitizedAnswer;
    }
  }

  return {
    ...groundedness,
    finalAnswer,
    expectedFormat,
    formatValidationRequired,
    formatValid,
    formatRepairAttempted,
    formatRepairSucceeded,
    piiDetected,
    piiCategories,
  };
}

// Orchestrates: verify -> (optional, bounded) revise -> re-verify -> decide.
// Only reached for an actual LLM-generated grounded draft (chat.service.ts
// never calls this for GREETING's canned reply or a deterministic
// not-found fallback — there's no draft to verify). Never throws; any
// verifier/revision failure degrades to the conservative fallback above
// rather than ever returning an unverified draft. Format/PII fields on its
// return value are still at buildResult()'s defaults — runOutputGuardrail
// below fills those in via applyFormatAndPiiGuards().
async function runGroundednessVerification(params: OutputGuardrailParams): Promise<OutputGuardrailResult> {
  if (!env.ANSWER_VERIFICATION.ENABLED) {
    return buildResult({
      finalAnswer: params.draftAnswer, verified: false, decision: null,
      reason: 'VERIFICATION_DISABLED', revisionAttempted: false, revisionSucceeded: false,
    });
  }

  const firstPass = await verifyAnswerGroundedness({
    question: params.question,
    uncoveredAspects: params.uncoveredAspects,
    evidenceTexts: params.evidenceTexts,
    draftAnswer: params.draftAnswer,
  });

  if (!firstPass.ok) {
    if (env.ANSWER_VERIFICATION.FAIL_OPEN_ON_VERIFIER_ERROR) {
      // No verdict was reached — the verifier never said the draft was
      // wrong, it just couldn't run. The draft was already generated from
      // retrieved evidence only; keep it. verified stays false so it is
      // never written to answer memory, and format/PII guards still run.
      logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Verifier unavailable (${firstPass.failureReason}) — serving unverified grounded draft (fail-open)`);
      return buildResult({
        finalAnswer: params.draftAnswer, verified: false, decision: null,
        reason: firstPass.failureReason, revisionAttempted: false, revisionSucceeded: false,
      });
    }
    logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Verification failed (${firstPass.failureReason}) — using conservative fallback`);
    return buildResult({
      finalAnswer: conservativeFallback(params), verified: false, decision: null,
      reason: firstPass.failureReason, revisionAttempted: false, revisionSucceeded: false,
    });
  }

  const verdict = firstPass.result;
  const counts = { unsupportedClaimCount: verdict.unsupportedClaims.length, missingAspectCount: verdict.missingAspects.length };

  if (verdict.decision === 'VERIFIED') {
    return buildResult({
      finalAnswer: params.draftAnswer, verified: true, decision: 'VERIFIED',
      reason: 'VERIFIED', revisionAttempted: false, revisionSucceeded: false, ...counts,
    });
  }

  if (verdict.decision === 'INSUFFICIENT_EVIDENCE') {
    // Matches section 9's flow: INSUFFICIENT_EVIDENCE goes straight to a
    // safe grounded fallback, never through revision — there's nothing a
    // rewrite could fix if the underlying evidence itself doesn't
    // support the request.
    logger.info(`[OUTPUT-GUARDRAIL] 🛡️  Draft judged INSUFFICIENT_EVIDENCE — using conservative fallback`);
    return buildResult({
      finalAnswer: conservativeFallback(params), verified: false, decision: verdict.decision,
      reason: verdict.reason, revisionAttempted: false, revisionSucceeded: false, ...counts,
    });
  }

  // REVISE — at most env.ANSWER_VERIFICATION.MAX_REVISIONS bounded
  // attempts (default 1): revise once, verify the revision once, then
  // stop regardless of outcome. Never an open-ended generate/verify/
  // revise loop.
  if (env.ANSWER_VERIFICATION.MAX_REVISIONS < 1) {
    return buildResult({
      finalAnswer: conservativeFallback(params), verified: false, decision: verdict.decision,
      reason: verdict.reason, revisionAttempted: false, revisionSucceeded: false, ...counts,
    });
  }

  logger.info(`[OUTPUT-GUARDRAIL] 🔧 Draft judged REVISE (${verdict.unsupportedClaims.length} unsupported claim(s)) — attempting one bounded revision`);
  const revision = await reviseAnswer({
    question: params.question,
    evidenceTexts: params.evidenceTexts,
    draftAnswer: params.draftAnswer,
    unsupportedClaims: verdict.unsupportedClaims,
    uncoveredAspects: params.uncoveredAspects,
  });

  if (!revision.ok) {
    logger.warn('[OUTPUT-GUARDRAIL] ⚠️  Revision failed — using conservative fallback');
    return buildResult({
      finalAnswer: conservativeFallback(params), verified: false, decision: verdict.decision,
      reason: 'REVISION_FAILED', revisionAttempted: true, revisionSucceeded: false, ...counts,
    });
  }

  // Never assume the revision succeeded — verify it exactly once more.
  const finalPass = await verifyAnswerGroundedness({
    question: params.question,
    uncoveredAspects: params.uncoveredAspects,
    evidenceTexts: params.evidenceTexts,
    draftAnswer: revision.revisedAnswer,
  });

  if (!finalPass.ok) {
    logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Final verification failed (${finalPass.failureReason}) — using conservative fallback`);
    return buildResult({
      finalAnswer: conservativeFallback(params), verified: false, decision: verdict.decision,
      reason: 'FINAL_VERIFICATION_FAILED', revisionAttempted: true, revisionSucceeded: false, ...counts,
    });
  }

  const finalCounts = { unsupportedClaimCount: finalPass.result.unsupportedClaims.length, missingAspectCount: finalPass.result.missingAspects.length };

  if (finalPass.result.decision === 'VERIFIED') {
    return buildResult({
      finalAnswer: revision.revisedAnswer, verified: true, decision: 'VERIFIED',
      reason: 'REVISED_AND_VERIFIED', revisionAttempted: true, revisionSucceeded: true, ...finalCounts,
    });
  }

  // Still not verified after the one bounded revision — conservative
  // fallback, never a second regeneration attempt.
  logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Revision still not verified (${finalPass.result.decision}) — using conservative fallback`);
  return buildResult({
    finalAnswer: conservativeFallback(params), verified: false, decision: finalPass.result.decision,
    reason: 'REVISED_BUT_UNVERIFIED', revisionAttempted: true, revisionSucceeded: false, ...finalCounts,
  });
}

// Top-level entry point used by chat.service.ts. Orchestrates the full
// target flow: groundedness verification/bounded revision (above) ->
// Selective Output Format Validation -> Output PII Leakage Detection ->
// final safe answer. The groundedness stage's own safety behavior
// (VERIFIED/REVISE/INSUFFICIENT_EVIDENCE, bounded revision, conservative
// fallback) is completely unchanged by this wrapper.
export async function runOutputGuardrail(params: OutputGuardrailParams): Promise<OutputGuardrailResult> {
  const run = async (): Promise<OutputGuardrailResult> => {
    const groundedness = await runGroundednessVerification(params);
    return applyFormatAndPiiGuards(params.effectiveQuery, groundedness, params.draftAnswer);
  };

  const trace = getActiveTrace();
  if (!trace) return run();
  return trace.span(
    'output-guardrail',
    run,
    (r: OutputGuardrailResult) => ({
      'answer_verification.enabled': env.ANSWER_VERIFICATION.ENABLED,
      'answer_verification.decision': r.decision,
      'answer_verification.reason': r.reason,
      'answer_verification.unsupported_claim_count': r.unsupportedClaimCount,
      'answer_verification.missing_aspect_count': r.missingAspectCount,
      'answer_verification.revision_attempted': r.revisionAttempted,
      'answer_verification.revision_count': r.revisionAttempted ? 1 : 0,
      'answer_verification.final_verified': r.verified,
      'answer_verification.provider': env.LLM.ANSWER_VERIFICATION.PROVIDER,
      'answer_verification.model': env.LLM.ANSWER_VERIFICATION.MODEL,
      ...(r.decision === null ? { 'answer_verification.failure_reason': r.reason } : {}),

      'output_guardrail.expected_format': r.expectedFormat,
      'output_guardrail.format_validation_required': r.formatValidationRequired,
      'output_guardrail.format_valid': r.formatValid,
      'output_guardrail.format_repair_attempted': r.formatRepairAttempted,
      'output_guardrail.format_repair_success': r.formatRepairSucceeded,

      'output_guardrail.pii_detected': r.piiDetected,
      'output_guardrail.pii_categories': r.piiCategories.join(','),
      'output_guardrail.pii_sanitized': r.piiDetected,
    }),
    (r: OutputGuardrailResult) => (r.verified ? 'SUCCESS' : 'FALLBACK')
  );
}
