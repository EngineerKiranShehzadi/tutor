import type { ExpectedResponseFormat, ResponseFormatValidationResult } from './response-format.types';

// A single stray "- " or "1." inside ordinary prose shouldn't count as a
// real list — require at least this many matching lines.
const MIN_LIST_ITEMS = 2;

const BULLET_LIST_LINE = /^[ \t]*[-*+][ \t]+\S/;
const NUMBERED_LIST_LINE = /^[ \t]*\d+[.)][ \t]+\S/;

function hasListStructure(text: string): boolean {
  const lines = text.split('\n');
  const bulletCount = lines.filter(line => BULLET_LIST_LINE.test(line)).length;
  const numberedCount = lines.filter(line => NUMBERED_LIST_LINE.test(line)).length;
  return bulletCount >= MIN_LIST_ITEMS || numberedCount >= MIN_LIST_ITEMS;
}

// A valid Markdown table needs a header row and, directly beneath it, a
// separator row of dashes (optionally colon-aligned) — the shape that
// actually renders as a table, not just any line containing a pipe.
const TABLE_ROW = /^\|.*\|$/;
const TABLE_SEPARATOR_ROW = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/;

function hasTableStructure(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW.test(lines[i]) && TABLE_SEPARATOR_ROW.test(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

// Structural check only — "does the requested structure exist and is it
// usable", never whether the content is factually correct (that's the
// groundedness verifier's job, already run before this).
export function validateResponseFormat(
  expectedFormat: ExpectedResponseFormat,
  answer: string
): ResponseFormatValidationResult {
  if (expectedFormat === 'NATURAL_TEXT') {
    return { expectedFormat, valid: true, repairRequired: false, reason: 'FORMAT_NOT_REQUIRED' };
  }

  if (expectedFormat === 'LIST') {
    const valid = hasListStructure(answer);
    return { expectedFormat, valid, repairRequired: !valid, reason: valid ? 'FORMAT_VALID' : 'LIST_STRUCTURE_MISSING' };
  }

  const valid = hasTableStructure(answer);
  return { expectedFormat, valid, repairRequired: !valid, reason: valid ? 'FORMAT_VALID' : 'TABLE_STRUCTURE_MISSING' };
}
