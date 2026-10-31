// Selective Output Format Validation — checks structure only, never facts.
// Groundedness/hallucination is entirely owned by answer-groundedness-
// verifier.service.ts; this stage never re-judges factual support.
//
// This app is a lecture assistant, not a general-purpose response-format
// system — deliberately only three formats, and NATURAL_TEXT (plain
// educational prose) is what most answers stay as.
export type ExpectedResponseFormat = 'NATURAL_TEXT' | 'LIST' | 'TABLE';

// Stable reason codes — same convention as AnswerVerificationReason/
// InputGuardrailReason: every outcome is named.
export const RESPONSE_FORMAT_REASONS = [
  'FORMAT_NOT_REQUIRED',
  'FORMAT_VALID',
  'LIST_STRUCTURE_MISSING',
  'TABLE_STRUCTURE_MISSING',
] as const;
export type ResponseFormatReason = typeof RESPONSE_FORMAT_REASONS[number];

export interface ResponseFormatValidationResult {
  expectedFormat: ExpectedResponseFormat;
  valid: boolean;
  repairRequired: boolean;
  reason: ResponseFormatReason;
}

// response-format-repair.service.ts's outcome — never throws, a failed
// repair just means the caller keeps the original (already grounded, just
// not restructured) answer instead. `method` says how the repair was made:
// DETERMINISTIC only re-punctuates the answer's own enumeration (no word is
// added or removed), LLM is a rewrite that must be checked before it is served.
export interface ResponseFormatRepairOutcome {
  ok: boolean;
  repairedAnswer?: string;
  method?: 'DETERMINISTIC' | 'LLM';
}

// Why a structurally valid repair was not served (the original answer is sent
// instead), from response-format-repair-check.service.ts: the rewrite added
// something, left something out, or changed what a statement says — or the
// check could not run, so the rewrite is unchecked.
export type FormatRepairRejection = 'NEW_CONTENT' | 'LOST_CONTENT' | 'CHANGED_MEANING' | 'CHECK_FAILED';
