// Deterministic PII value patterns — the single source of truth for both
// the input guard (input/guards/pii-detection.guard.ts) and the output
// leakage guard (output/pii/output-pii-leakage.guard.ts), applied via
// pii-detector.service.ts (including the extra validation some of them
// need, e.g. Luhn-checking a credit-card-shaped match before trusting it).
// Kept separate from the detector itself so the detection rules can be
// read/audited on their own.
//
// Each pattern matches an actual *value* shape, never a word that merely
// discusses the concept — "What is PII?" and "Why should an email be
// protected?" contain no matches against any of these.

export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;

// Broad candidate shape for phone numbers — deliberately over-matches (a
// bare "7:09" lecture timestamp won't match since it requires 3+ digit
// groups separated by space/dot/dash/parens, not a colon), then
// pii-detector.service.ts filters candidates by total digit count so short
// coincidental numeric runs (chunk ids, timestamps already excluded by
// shape) aren't flagged.
export const PHONE_CANDIDATE_PATTERN = /\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{1,4})?/g;

// Broad candidate shape for credit-card-like numbers — pii-detector.service.ts
// Luhn-validates each match before treating it as real PII, so an
// unrelated 16-digit id/hash doesn't get flagged as a card number.
export const CREDIT_CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})\b/g;

// Government/national-identifier formats — kept as a named group so
// pii-detector.service.ts can label all of them under the single
// [IDENTIFIER] placeholder/category without the caller needing to know how
// many concrete formats exist.
export const IDENTIFIER_PATTERNS = [
  /\b\d{5}-\d{7}-\d{1}\b/g,   // CNIC (Pakistan)
  /\b\d{3}-\d{2}-\d{4}\b/g,   // SSN-shaped (US)
];
