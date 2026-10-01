// Cheap, deterministic candidate detection — the gate that decides whether
// subquery-decomposition.service.ts is even allowed to consider an LLM
// call. Signals are grouped and named, not one giant regex, so each family
// can be read/extended independently (same convention as the input
// guardrail's pattern files).
//
// These signals only ever widen the funnel toward a semantic decision —
// they never themselves produce subqueries or a DECOMPOSE verdict. A match
// means "worth asking the LLM", nothing stronger.

const COMPARISON_PATTERNS = [
  /\bcompare\b/i,
  /\bcomparison\s+(?:of|between)\b/i,
  /\bversus\b|\bvs\.?\b/i,
  /\bdifference(?:s)?\s+between\b/i,
  /\bcontrast(?:ing)?\b/i,
];

// Two or more distinct requests bundled into one message — "explain X and
// also describe Y", "explain X and compare it with Y and describe Z".
const MULTI_REQUEST_PATTERNS = [
  /\band\s+(?:also\s+)?(?:explain|describe|discuss|list|summarize)\b/i,
  /\bexplain\b.{0,80}\band\b.{0,80}\bcompare\b/i,
];

// Two or more '?' — reads as several separate questions typed as one
// message rather than one compound concept.
const MULTIPLE_QUESTIONS_PATTERN = /\?.*\?/s;

export type CompoundQuerySignal = 'COMPARISON' | 'MULTI_REQUEST' | 'MULTIPLE_QUESTIONS';

export interface CompoundQueryDetection {
  isCandidate: boolean;
  matchedSignals: CompoundQuerySignal[];
}

export function detectCompoundQueryCandidate(text: string): CompoundQueryDetection {
  const matchedSignals: CompoundQuerySignal[] = [];
  if (COMPARISON_PATTERNS.some(re => re.test(text))) matchedSignals.push('COMPARISON');
  if (MULTI_REQUEST_PATTERNS.some(re => re.test(text))) matchedSignals.push('MULTI_REQUEST');
  if (MULTIPLE_QUESTIONS_PATTERN.test(text)) matchedSignals.push('MULTIPLE_QUESTIONS');
  return { isCandidate: matchedSignals.length > 0, matchedSignals };
}
