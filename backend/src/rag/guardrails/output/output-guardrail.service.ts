import { env } from '../../../config/env';
import { getActiveTrace } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { verifyAnswerGroundedness } from './answer-groundedness-verifier.service';
import { reviseAnswer } from './answer-revision.service';
import { detectExpectedResponseFormat } from './format/response-format.detector';
import { validateResponseFormat } from './format/response-format.guard';
import { repairResponseFormat } from './format/response-format-repair.service';
import { checkFormatRepair } from './format/response-format-repair-check.service';
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
  // Aspects whose lookup failed (outage), not "not in the lecture" — see
  // generateAnswer's unavailableAspects. The verifier/revision treat them as
  // parts that must not be answered; the fallback names them honestly.
  unavailableAspects?: string[];
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
  const base = params.uncoveredAspects.length === 0
    ? params.notFoundMessage
    : `I could not find enough information in this lecture to fully answer this — specifically: ${params.uncoveredAspects.join('; ')}.`;
  const unavailable = params.unavailableAspects ?? [];
  if (unavailable.length === 0) return base;
  return `${base} I also couldn't retrieve part of this right now (${unavailable.join('; ')}) — please ask again in a moment.`;
}

// Outcomes where the verifier could not reach a verdict at all. Failing
// closed on these must not claim the lecture lacks the topic (retrieval
// already found evidence above both floors), so they carry
// verificationUnavailable and chat.service.ts turns them into a 503.
const VERIFIER_INFRA_FAILURES: ReadonlySet<OutputGuardrailReason> = new Set<OutputGuardrailReason>([
  'VERIFIER_TIMEOUT', 'VERIFIER_PROVIDER_ERROR', 'VERIFIER_INVALID_OUTPUT',
  'REVISION_FAILED', 'FINAL_VERIFICATION_FAILED',
]);
export const VERIFICATION_UNAVAILABLE_MESSAGE =
  "I couldn't check this answer against the lecture right now. Please ask again in a moment.";

// Parts the verifier/revision must treat as "do not answer": the ones not in
// the lecture and the ones that couldn't be looked up.
const aspectsNotToAnswer = (params: OutputGuardrailParams): string[] =>
  [...params.uncoveredAspects, ...(params.unavailableAspects ?? [])];

function buildResult(args: {
  finalAnswer: string;
  verified: boolean;
  decision: AnswerVerificationDecision | null;
  reason: OutputGuardrailReason;
  revisionAttempted: boolean;
  revisionSucceeded: boolean;
  unsupportedClaimCount?: number;
  missingAspectCount?: number;
  verificationUnavailable?: boolean;
}): OutputGuardrailResult {
  return {
    finalAnswer: args.finalAnswer,
    verified: args.verified,
    decision: args.decision,
    reason: args.reason,
    revisionAttempted: args.revisionAttempted,
    revisionSucceeded: args.revisionSucceeded,
    // Only ever true for an infra reason, whatever a caller passes.
    verificationUnavailable: args.verificationUnavailable === true && VERIFIER_INFRA_FAILURES.has(args.reason),
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
    formatRepairRejected: null,
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
  draftAnswer: string,
  notFoundMessage: string
): Promise<OutputGuardrailResult> {
  // Format validation only ever applies to real generated content. When the
  // groundedness stage fell back to its deterministic conservative message
  // (verified=false and it's not merely that verification is disabled),
  // that fallback is already safe static copy that was never asked to be a
  // list/table in the first place — reformatting an "I could not find
  // this..." apology would be pointless and could look like fabrication.
  // A fail-open draft is real generated content (unverified, but not a
  // static fallback), so it still gets format validation.
  // The model is told to answer with exactly the not-found sentence when the
  // evidence is missing, so that refusal often IS the draft (even a verified
  // one): it is never sent for a LIST/TABLE "repair" either, which would invite
  // invented bullets.
  const isFallbackAnswer = groundedness.verificationUnavailable
    || groundedness.finalAnswer.trim() === notFoundMessage.trim()
    || (!groundedness.verified
      && groundedness.reason !== 'VERIFICATION_DISABLED'
      && groundedness.finalAnswer !== draftAnswer);

  let finalAnswer = groundedness.finalAnswer;
  let expectedFormat: ExpectedResponseFormat = 'NATURAL_TEXT';
  let formatValidationRequired = false;
  let formatValid = true;
  let formatRepairAttempted = false;
  let formatRepairSucceeded = false;
  let formatRepairRejected: OutputGuardrailResult['formatRepairRejected'] = null;

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
        // The groundedness check above judged the original, not this
        // rewrite, so an LLM rewrite is served only after one more call
        // confirms it says the same thing: nothing added (an invented bullet
        // or header), nothing left out (a cut item), no statement changed (a
        // lost "not"). If that call fails, the rewrite is unchecked and the
        // original is kept. A deterministic repair only re-punctuates the
        // answer's own enumeration, so it needs no check.
        const structurallyValid = repair.ok && !!repair.repairedAnswer
          && validateResponseFormat(expectedFormat, repair.repairedAnswer).valid;
        if (!structurallyValid) {
          logger.warn('[OUTPUT-GUARDRAIL] ⚠️  Format repair did not produce a valid structure — keeping original grounded answer');
        } else {
          const check = repair.method === 'DETERMINISTIC'
            ? null
            : await checkFormatRepair(expectedFormat, finalAnswer, repair.repairedAnswer!);
          if (check && !check.ok) {
            formatRepairRejected = 'CHECK_FAILED';
            logger.warn('[OUTPUT-GUARDRAIL] ⚠️  Format repair could not be checked — keeping original grounded answer');
          } else if (check && check.verdict.rejected) {
            formatRepairRejected = check.verdict.rejected;
            logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Format repair rejected (${check.verdict.rejected}: ${check.verdict.added.length} added, ${check.verdict.dropped.length} dropped, ${check.verdict.changed.length} changed) — keeping original grounded answer`);
          } else {
            finalAnswer = repair.repairedAnswer!;
            formatValid = true;
            formatRepairSucceeded = true;
          }
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
    formatRepairRejected,
    piiDetected,
    piiCategories,
  };
}

// Orchestrates: verify -> (optional, bounded) revise -> re-verify -> decide.
// Only reached for an actual LLM-generated grounded draft (chat.service.ts
// never calls this for GREETING's canned reply or a deterministic
// not-found fallback — there's no draft to verify). Never throws; a
// verifier/revision failure returns verificationUnavailable (the caller
// reports an error) and never an unverified draft. Format/PII fields on its
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
    uncoveredAspects: aspectsNotToAnswer(params),
    evidenceTexts: params.evidenceTexts,
    draftAnswer: params.draftAnswer,
  });

  if (!firstPass.ok) {
    if (env.ANSWER_VERIFICATION.FAIL_OPEN_ON_VERIFIER_ERROR) {
      // Opt-in only (ANSWER_VERIFICATION_FAIL_OPEN=true; default is fail
      // closed, below). No verdict was reached — the verifier couldn't run.
      // verified stays false so the draft is never written to answer
      // memory, and format/PII guards still run.
      logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Verifier unavailable (${firstPass.failureReason}) — serving unverified grounded draft (fail-open)`);
      return buildResult({
        finalAnswer: params.draftAnswer, verified: false, decision: null,
        reason: firstPass.failureReason, revisionAttempted: false, revisionSucceeded: false,
      });
    }
    logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Verifier unavailable (${firstPass.failureReason}) — failing closed, answer not served`);
    return buildResult({
      finalAnswer: VERIFICATION_UNAVAILABLE_MESSAGE, verified: false, decision: null,
      reason: firstPass.failureReason, revisionAttempted: false, revisionSucceeded: false,
      verificationUnavailable: true,
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
    uncoveredAspects: aspectsNotToAnswer(params),
  });

  if (!revision.ok) {
    logger.warn('[OUTPUT-GUARDRAIL] ⚠️  Revision failed — failing closed, answer not served');
    return buildResult({
      finalAnswer: VERIFICATION_UNAVAILABLE_MESSAGE, verified: false, decision: verdict.decision,
      reason: 'REVISION_FAILED', revisionAttempted: true, revisionSucceeded: false, ...counts,
      verificationUnavailable: true,
    });
  }

  // Never assume the revision succeeded — verify it exactly once more.
  const finalPass = await verifyAnswerGroundedness({
    question: params.question,
    uncoveredAspects: aspectsNotToAnswer(params),
    evidenceTexts: params.evidenceTexts,
    draftAnswer: revision.revisedAnswer,
  });

  if (!finalPass.ok) {
    logger.warn(`[OUTPUT-GUARDRAIL] ⚠️  Final verification failed (${finalPass.failureReason}) — failing closed, answer not served`);
    return buildResult({
      finalAnswer: VERIFICATION_UNAVAILABLE_MESSAGE, verified: false, decision: verdict.decision,
      reason: 'FINAL_VERIFICATION_FAILED', revisionAttempted: true, revisionSucceeded: false, ...counts,
      verificationUnavailable: true,
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
    return applyFormatAndPiiGuards(params.effectiveQuery, groundedness, params.draftAnswer, params.notFoundMessage);
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
      'answer_verification.unavailable': r.verificationUnavailable,
      'answer_verification.provider': env.LLM.ANSWER_VERIFICATION.PROVIDER,
      'answer_verification.model': env.LLM.ANSWER_VERIFICATION.MODEL,
      ...(r.decision === null ? { 'answer_verification.failure_reason': r.reason } : {}),

      'output_guardrail.expected_format': r.expectedFormat,
      'output_guardrail.format_validation_required': r.formatValidationRequired,
      'output_guardrail.format_valid': r.formatValid,
      'output_guardrail.format_repair_attempted': r.formatRepairAttempted,
      'output_guardrail.format_repair_success': r.formatRepairSucceeded,
      'output_guardrail.format_repair_rejected': r.formatRepairRejected,

      'output_guardrail.pii_detected': r.piiDetected,
      'output_guardrail.pii_categories': r.piiCategories.join(','),
      'output_guardrail.pii_sanitized': r.piiDetected,
    }),
    (r: OutputGuardrailResult) => (r.verificationUnavailable ? 'ERROR' : r.verified ? 'SUCCESS' : 'FALLBACK')
  );
}
