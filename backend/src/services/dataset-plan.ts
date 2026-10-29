// Pure matching logic for dataset updates — no DB, no I/O, so every rule can
// be unit-tested directly. dataset-version.service.ts feeds it the parsed file
// and the lecture's currently-active Q&As and acts on the result.
//
// Identity rules (a file row is matched to an existing Q&A of the SAME lecture):
//  1. A row carrying a qa_id is that Q&A. An unknown qa_id is an error —
//     ids are assigned by the backend, never invented by the file.
//  2. A row without qa_id matches only on an exact, unique question
//     (whitespace-normalised). Zero matches => a new Q&A.
//  3. If a question is not unique — several existing Q&As or several file rows
//     share it — the row is matched ONLY to an existing Q&A whose content is
//     identical (so the match can never overwrite anything). Rows left over
//     are new Q&As if every existing candidate was already consumed by an
//     identical row; otherwise the match is ambiguous and the whole upload is
//     rejected. We never guess which Q&A an edited row was meant to replace.
// Editing the text of a question therefore needs its qa_id.

export interface QaFields {
  topic: string | null;
  question: string;
  answer: string;
  start_time: string | null;
  end_time: string | null;
  keywords: string | null;
  llm_name: string | null;
}

export interface FileRow extends QaFields {
  qaId: string | null;
  // 1-based spreadsheet row number (header is row 1) — only for messages.
  sheetRow: number;
}

export interface ActiveQa {
  qaId: string;
  fields: QaFields;
}

export interface RowMatch {
  rowIndex: number;
  qaId: string;
  isNew: boolean;
}

export interface MatchResult {
  matches: RowMatch[];
  errors: string[];
}

export const normalizeQuestionKey = (q: string): string => q.trim().replace(/\s+/g, ' ');

export const fieldsEqual = (a: QaFields, b: QaFields): boolean =>
  a.topic === b.topic &&
  a.question === b.question &&
  a.answer === b.answer &&
  a.start_time === b.start_time &&
  a.end_time === b.end_time &&
  a.keywords === b.keywords &&
  a.llm_name === b.llm_name;

export const matchRows = (
  fileRows: FileRow[],
  activeQas: ActiveQa[],
  newQaId: () => string
): MatchResult => {
  const errors: string[] = [];
  const matchByRow = new Map<number, RowMatch>();
  const activeById = new Map(activeQas.map(q => [q.qaId, q]));
  const claimed = new Set<string>();

  // 1. Explicit qa_ids.
  fileRows.forEach((row, i) => {
    if (!row.qaId) return;
    if (!activeById.has(row.qaId)) {
      errors.push(`Row ${row.sheetRow}: qa_id "${row.qaId}" does not exist in this lecture's dataset`);
      return;
    }
    if (claimed.has(row.qaId)) {
      errors.push(`Row ${row.sheetRow}: qa_id "${row.qaId}" appears more than once in the file`);
      return;
    }
    claimed.add(row.qaId);
    matchByRow.set(i, { rowIndex: i, qaId: row.qaId, isNew: false });
  });

  // 2./3. Rows without qa_id, grouped by question.
  const groups = new Map<string, number[]>();
  fileRows.forEach((row, i) => {
    if (row.qaId) return;
    const key = normalizeQuestionKey(row.question);
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });

  const activeByQuestion = new Map<string, ActiveQa[]>();
  for (const q of activeQas) {
    if (claimed.has(q.qaId)) continue; // already taken by an explicit qa_id row
    const key = normalizeQuestionKey(q.fields.question);
    const g = activeByQuestion.get(key);
    if (g) g.push(q); else activeByQuestion.set(key, [q]);
  }

  for (const [key, rowIdxs] of groups) {
    const candidates = activeByQuestion.get(key) ?? [];

    if (candidates.length === 0) {
      for (const i of rowIdxs) matchByRow.set(i, { rowIndex: i, qaId: newQaId(), isNew: true });
      continue;
    }

    if (rowIdxs.length === 1 && candidates.length === 1) {
      const i = rowIdxs[0];
      claimed.add(candidates[0].qaId);
      matchByRow.set(i, { rowIndex: i, qaId: candidates[0].qaId, isNew: false });
      continue;
    }

    // Non-unique question: only identical-content matches are safe.
    const free = [...candidates];
    const leftover: number[] = [];
    for (const i of rowIdxs) {
      const at = free.findIndex(c => fieldsEqual(c.fields, fileRows[i]));
      if (at === -1) { leftover.push(i); continue; }
      const [taken] = free.splice(at, 1);
      claimed.add(taken.qaId);
      matchByRow.set(i, { rowIndex: i, qaId: taken.qaId, isNew: false });
    }
    if (leftover.length === 0) continue;
    if (free.length === 0) {
      // Every existing Q&A with this question is accounted for by an identical
      // row, so the remaining rows can only be additions.
      for (const i of leftover) matchByRow.set(i, { rowIndex: i, qaId: newQaId(), isNew: true });
      continue;
    }
    const rowsTxt = leftover.map(i => fileRows[i].sheetRow).join(', ');
    errors.push(
      `Row(s) ${rowsTxt}: the question "${truncate(key)}" matches ${candidates.length} existing Q&A(s) and the match is ambiguous — ` +
      `add the qa_id (export the current dataset to get it) instead of relying on the question text`
    );
  }

  if (errors.length > 0) return { matches: [], errors };
  const matches = fileRows.map((_, i) => matchByRow.get(i)!);
  return { matches, errors: [] };
};

const truncate = (s: string, n = 70): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
