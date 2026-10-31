import type { ExpectedResponseFormat } from './response-format.types';

// Cheap, deterministic detection of an explicitly requested output format —
// never an LLM call. Signals are grouped and named per format family, same
// convention as compound-query.detector.ts and the input guardrail's
// pattern files, rather than one large unreadable regex.
//
// NATURAL_TEXT is the default whenever nothing matches — an ordinary
// question ("What is prompt engineering?", "Explain few-shot prompting")
// never reaches format validation at all. A bare comparison request
// ("Compare zero-shot and few-shot prompting.") also stays NATURAL_TEXT;
// TABLE only fires when a table is explicitly asked for.

// Request phrasing only — never the bare nouns, which are often the subject
// matter ("What is a linked list?", "How does a lookup table work?"): a
// correct prose answer to those must not be sent for a format "repair".
const LIST_SIGNALS = [
  /\blist\s+(?:the|all|some|me|out|each|every|down)\b/i,                 // "list the types…"
  /\b(?:as|in)\s+(?:a\s+)?(?:bulleted\s+|numbered\s+)?list\b/i,          // "as a list", "in a bulleted list"
  /\bbullet(?:s|ed)?(?:\s*points?)?\b/i,
  /\bnumbered\s+list\b/i,
  /\bin\s+points\b/i,
  /\b(?:give|name|list)\s+(?:me\s+)?\d+\b/i,                             // "give me 5 points/reasons/examples"
  /\bstep[-\s]by[-\s]step\b/i,
];

const TABLE_SIGNALS = [
  /\b(?:as|in|into)\s+(?:a\s+)?table\b/i,                                // "in a table", "into a table"
  /\btabular(?:\s+form(?:at)?)?\b/i,
  /\bin\s+columns\b/i,
  /\bcomparison\s+table\b/i,
  /\btabulate\b/i,
];

// TABLE is checked first — it's the more specific/explicit structural ask,
// so a query matching both groups (unlikely, but e.g. "list this in a
// table") should still resolve to the stronger requested structure.
export function detectExpectedResponseFormat(effectiveQuery: string): ExpectedResponseFormat {
  if (TABLE_SIGNALS.some(re => re.test(effectiveQuery))) return 'TABLE';
  if (LIST_SIGNALS.some(re => re.test(effectiveQuery))) return 'LIST';
  return 'NATURAL_TEXT';
}
