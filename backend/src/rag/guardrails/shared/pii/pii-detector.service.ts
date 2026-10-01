import {
  EMAIL_PATTERN,
  PHONE_CANDIDATE_PATTERN,
  CREDIT_CARD_CANDIDATE_PATTERN,
  IPV4_PATTERN,
  IDENTIFIER_PATTERNS,
} from './pii.patterns';
import type { PiiCategory, PiiScanResult } from './pii.types';

function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

interface Redaction {
  start: number;
  end: number;
  placeholder: string;
  category: PiiCategory;
}

// Runs every pattern against the text and collects candidate matches.
// Numeric patterns (credit card, phone) get an extra validity check here —
// Luhn for cards, digit-count bounds for phones — so an unrelated long
// numeric id/hash (in a lecture question, or in a generated answer) doesn't
// get flagged as real PII.
function findRedactions(text: string): Redaction[] {
  const redactions: Redaction[] = [];

  for (const match of text.matchAll(EMAIL_PATTERN)) {
    redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[EMAIL]', category: 'EMAIL' });
  }

  for (const match of text.matchAll(IPV4_PATTERN)) {
    redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[IP_ADDRESS]', category: 'IP_ADDRESS' });
  }

  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[IDENTIFIER]', category: 'IDENTIFIER' });
    }
  }

  for (const match of text.matchAll(CREDIT_CARD_CANDIDATE_PATTERN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[CREDIT_CARD]', category: 'CREDIT_CARD' });
    }
  }

  for (const match of text.matchAll(PHONE_CANDIDATE_PATTERN)) {
    const digitCount = (match[0].match(/\d/g) ?? []).length;
    if (digitCount >= 7 && digitCount <= 15) {
      redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[PHONE]', category: 'PHONE' });
    }
  }

  return redactions;
}

// Resolves overlapping candidate matches (e.g. a credit-card candidate
// partially overlapping a phone candidate) by earliest-start then
// longest-first, dropping anything that overlaps a match already kept —
// so redaction never double-counts or corrupts the same span twice.
function resolveOverlaps(redactions: Redaction[]): Redaction[] {
  const sorted = [...redactions].sort(
    (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start)
  );
  const kept: Redaction[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.start >= lastEnd) {
      kept.push(r);
      lastEnd = r.end;
    }
  }
  return kept;
}

// Single source of truth for PII value detection/sanitization — shared by
// the input guard (input/guards/pii-detection.guard.ts, protects the RAG
// pipeline from sensitive values flowing in) and the output leakage guard
// (output/pii/output-pii-leakage.guard.ts, protects the final generated
// answer from exposing sensitive values). Neither guard duplicates any
// regex/pattern logic — both call this function and only differ in how they
// wrap its result (InputGuardrailResult vs OutputPiiGuardResult).
//
// Detects actual PII values (never words that merely discuss the concept —
// "What is PII?" matches nothing) and replaces each one with a category
// placeholder. The original values are never returned anywhere — only
// category labels reach the result, which is the only part of a scan that's
// safe to put in logs/traces/metadata.
export function scanForPii(text: string): PiiScanResult {
  const redactions = resolveOverlaps(findRedactions(text));
  if (redactions.length === 0) {
    return { detected: false, sanitizedText: text, detectedCategories: [] };
  }

  let sanitized = '';
  let cursor = 0;
  for (const r of redactions) {
    sanitized += text.slice(cursor, r.start) + r.placeholder;
    cursor = r.end;
  }
  sanitized += text.slice(cursor);

  const detectedCategories = Array.from(new Set(redactions.map(r => r.category)));

  return { detected: true, sanitizedText: sanitized, detectedCategories };
}
