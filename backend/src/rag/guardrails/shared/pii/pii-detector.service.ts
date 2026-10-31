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

// A phone-shaped match counts only when it is written like a phone number.
// A separated form counts unless it reads as something else: a decimal
// ("3.14159265358979"), a dotted quad (left to the IPv4 check), a number
// grouped in thousands ("1 000 000 000"), or a code ending in a single check
// digit (the ISBN "0-13-468599-1"). A bare run is judged by bareRunIsPhone.
function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (candidate.startsWith('+')) return true;

  const separators = candidate.match(/[-.\s()]+/g) ?? [];
  if (separators.length === 0) return bareRunIsPhone(digits);

  const groups = candidate.split(/[-.\s()]+/).filter(g => g !== '');
  const onlySeparator = new Set(separators).size === 1 ? separators[0] : null;
  if (onlySeparator === '.' && groups.length === 2) return false;
  if (onlySeparator === '.' && groups.length === 4 && groups.every(g => g.length <= 3)) return false;
  if ((onlySeparator === ' ' || onlySeparator === '.')
    && /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every(g => g.length === 3)) return false;
  if (groups[groups.length - 1].length === 1) return false;
  return true;
}

// A bare digit run with no "+" is a phone number when it has a dialled shape:
// a trunk "0" national number (03001234567), "1" plus a 10-digit North
// American number (14155552671), or 10-13 digits starting 2-9 (a national
// number, 4155552671, or country code + number, 923001234567). Shorter runs
// are left alone, and so are runs that read as a quantity (quantityShaped).
function bareRunIsPhone(digits: string): boolean {
  if (quantityShaped(digits)) return false;
  if (digits.startsWith('0')) return digits.length === 10 || digits.length === 11;
  if (digits.startsWith('1')) return digits.length === 11;
  return digits.length >= 10 && digits.length <= 13;
}

// Lectures write quantities as bare digit runs. A run of five or more zeros is
// a round number or a modulus (175000000000, 1000000007), a power of two or one
// either side of it is a computing limit (4294967296, 2147483647), and a run of
// one repeated digit or of only 0s and 1s is a placeholder or binary.
function quantityShaped(digits: string): boolean {
  if (/0{5,}/.test(digits) || /^(\d)\1+$/.test(digits) || /^[01]+$/.test(digits)) return true;
  const n = BigInt(digits);
  return [n - BigInt(1), n, n + BigInt(1)].some(m => m > BigInt(0) && (m & (m - BigInt(1))) === BigInt(0));
}

// "Chapter 10.2.3.4", "version 1.2.3.4", "§ 4.1.2.3", "Fig. 2.1.1.3", and the
// later numbers of a list ("Sections 3.1.2.1 and 3.1.2.2").
const SECTION_CUE = /(?:\b(?:chapters?|ch|sections?|sec|subsections?|parts?|versions?|ver|v|releases?|builds?|rev|revisions?|figures?|figs?|tables?|equations?|eqs?|steps?|clauses?|items?|units?|modules?|lessons?|exercises?|ex|problems?|appendix|appendices|rules?|paragraphs?|para|pages?|pp?|theorems?|lemmas?|definitions?|examples?|listings?)\.?|§)\s*(?:[\d.]+\s*(?:,|&|and|or|to|-|–)\s*)*$/i;
const SECTION_CUE_WINDOW = 80;

// An IPv4 address counts unless it identifies no one: private, loopback,
// link-local, carrier-grade NAT, documentation, and multicast/reserved (which
// also covers netmasks such as 255.255.255.0) — networking lectures are full
// of these — or unless the text right before it names it as a section or
// version number (SECTION_CUE). The shape alone cannot tell "10.2.3.4" from a
// public address such as 8.8.8.8, so only the cue does.
function looksLikePersonalIpv4(candidate: string, textBefore: string): boolean {
  if (SECTION_CUE.test(textBefore)) return false;
  const [a, b, c] = candidate.split('.').map(Number);
  const nonPersonal = a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
  return !nonPersonal;
}

interface Redaction {
  start: number;
  end: number;
  placeholder: string;
  category: PiiCategory;
}

// Runs every pattern against the text and collects candidate matches.
// Numeric patterns (credit card, phone, IP) get an extra validity check here —
// Luhn for cards, phone and address shape for the others — so an unrelated
// long numeric id/hash/quantity (in a lecture question, or in a generated
// answer) doesn't get flagged as real PII.
function findRedactions(text: string): Redaction[] {
  const redactions: Redaction[] = [];

  for (const match of text.matchAll(EMAIL_PATTERN)) {
    redactions.push({ start: match.index!, end: match.index! + match[0].length, placeholder: '[EMAIL]', category: 'EMAIL' });
  }

  for (const match of text.matchAll(IPV4_PATTERN)) {
    if (!looksLikePersonalIpv4(match[0], text.slice(Math.max(0, match.index! - SECTION_CUE_WINDOW), match.index!))) continue;
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
    if (looksLikePhone(match[0])) {
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
