// Stable reason codes for every InputGuardrailResult — never a free-text
// string. Observability/logging/metadata/tests all key off these exact
// values, so a guard adding a new failure mode adds it here first.
export const INPUT_GUARDRAIL_REASONS = [
  'INPUT_TOO_LONG',
  'PII_DETECTED',
  'PROMPT_INJECTION',
  'MALICIOUS_PAYLOAD',
  'GUARDRAIL_CLASSIFIER_TIMEOUT',
  'GUARDRAIL_CLASSIFIER_ERROR',
] as const;

export type InputGuardrailReason = typeof INPUT_GUARDRAIL_REASONS[number];

// Generic, user-safe messages shown to the student on REJECT — deliberately
// do not describe the detection mechanics (helps nobody but an attacker
// tuning their next attempt). INPUT_TOO_LONG is the one reason worth being
// specific about, since it's the one legitimate students will hit by
// accident and can actually act on.
export const REJECTION_MESSAGE_BY_REASON: Record<InputGuardrailReason, string> = {
  INPUT_TOO_LONG: 'Your question is too long. Please shorten it and try again.',
  PII_DETECTED: 'Your message could not be processed. Please rephrase your question.',
  PROMPT_INJECTION: 'Your message could not be processed. Please ask a direct question about the lecture content.',
  MALICIOUS_PAYLOAD: 'Your message could not be processed. Please ask a direct question about the lecture content.',
  GUARDRAIL_CLASSIFIER_TIMEOUT: 'Your message could not be processed right now. Please try again in a moment.',
  GUARDRAIL_CLASSIFIER_ERROR: 'Your message could not be processed right now. Please try again in a moment.',
};
