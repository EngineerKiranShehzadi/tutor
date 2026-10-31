import * as XLSX from 'xlsx';
import { env } from '../config/env';
import { assertSafeXlsx } from '../utils/xlsx-guard';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import type { FileRow } from './dataset-plan';

export interface RawRow {
  qa_id?: string;
  topic?: string;
  question?: string;
  answer?: string;
  start_time?: string;
  end_time?: string;
  keywords?: string;
  llm_name?: string;
}

// Non-enumerable key holding a parsed row's real spreadsheet row number.
const SHEET_ROW = Symbol('sheetRow');

export interface ChunkPiece {
  chunkIndex: number;
  chunkText: string;
}

// Only content that carries meaning about the lecture goes into the text that
// gets embedded. Bookkeeping fields — which LLM wrote the row, and where in the
// transcript/slides it came from — are still stored on the row and shown in the
// UI, but are deliberately kept OUT of the vector: they are identical or
// near-identical across rows, so they add no distinguishing signal and only
// dilute the part that matters.
function buildChunkText(row: RawRow): string {
  return [
    row.topic ? `Topic: ${row.topic}` : null,
    `Question: ${row.question}`,
    `Answer: ${row.answer}`,
    row.keywords ? `Keywords: ${row.keywords}` : null,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

// The local embedding server (BAAI/bge-large-en-v1.5) truncates silently past
// 512 tokens — anything beyond that is dropped from the vector with no error.
// Rows below this char threshold (~450 tokens, ~4 chars/token, kept under
// budget) are embedded whole, unchanged from before. Only rows that would
// actually risk truncation get split.
export const SPLIT_THRESHOLD_CHARS = 1800;

// Character-based, not token-based — no tokenizer dependency was added to
// keep this addition small and auditable. Sized conservatively so a chunk
// plus its Topic/Question prefix still lands safely under the 512-token
// embedding limit for ordinary English text.
export const SPLIT_CHUNK_SIZE = 1200;
export const SPLIT_CHUNK_OVERLAP = 150;

// Largest structural break to smallest, so a split prefers paragraph and
// sentence boundaries and only falls back to a raw word/character cut for
// text that has none.
export const SPLIT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

// Hard ceiling on pieces per row. Without this, one malformed/malicious
// spreadsheet cell (e.g. a multi-megabyte answer with no whitespace to split
// on) could fan out into thousands of chunks and hammer the embedding server
// and DB on upload — an ingestion-side resource-exhaustion risk, not just a
// quality one. Truncation here is logged, never silent.
export const MAX_PIECES_PER_ROW = 20;

// Identifies the chunking settings. Stored on every dataset version so a
// version built under different settings is distinguishable; a settings change
// also changes chunk_text (hence content_hash) of any row it affects, which is
// what triggers re-embedding of exactly those rows.
export const CHUNKING_CONFIG_VERSION =
  `rcts:${SPLIT_THRESHOLD_CHARS}/${SPLIT_CHUNK_SIZE}/${SPLIT_CHUNK_OVERLAP}/${MAX_PIECES_PER_ROW}`;

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: SPLIT_CHUNK_SIZE,
  chunkOverlap: SPLIT_CHUNK_OVERLAP,
  separators: SPLIT_SEPARATORS,
});

// Splits a row into one or more embeddable pieces. Short rows (the common
// case today) are returned unchanged as a single piece, so nothing about
// existing lectures' chunk count/content changes. Long rows have their
// *answer* split by LangChain's RecursiveCharacterTextSplitter, with the
// row's topic/question re-prefixed onto every piece so each one is still
// self-contained if retrieved on its own.
export async function buildChunkPieces(row: RawRow): Promise<ChunkPiece[]> {
  return (await buildChunkPiecesReport(row)).pieces;
}

// Same as buildChunkPieces, plus how many pieces the answer split into before
// the MAX_PIECES_PER_ROW cap — so the upload preview can show truncated rows.
export async function buildChunkPiecesReport(row: RawRow): Promise<{ pieces: ChunkPiece[]; splitInto: number }> {
  const whole = buildChunkText(row);
  if (whole.length <= SPLIT_THRESHOLD_CHARS) {
    return { pieces: [{ chunkIndex: 0, chunkText: whole }], splitInto: 1 };
  }

  const answer = String(row.answer ?? '');
  let parts: string[];
  try {
    parts = await splitter.splitText(answer);
  } catch (err) {
    logger.error('[CHUNK] ⚠️  Splitter failed, falling back to a single unsplit chunk', err);
    return { pieces: [{ chunkIndex: 0, chunkText: whole }], splitInto: 1 };
  }

  const splitInto = parts.length;
  if (parts.length > MAX_PIECES_PER_ROW) {
    logger.warn(
      `[CHUNK] ⚠️  Row split into ${parts.length} pieces, exceeding the ${MAX_PIECES_PER_ROW}-piece cap — ` +
      `keeping the first ${MAX_PIECES_PER_ROW} and dropping the rest. Check this row's answer length.`
    );
    parts = parts.slice(0, MAX_PIECES_PER_ROW);
  }

  const pieces = parts.map((part, chunkIndex) => ({
    chunkIndex,
    chunkText: [
      row.topic ? `Topic: ${row.topic}` : null,
      `Question: ${row.question}`,
      `Answer: ${part}`,
      row.keywords ? `Keywords: ${row.keywords}` : null,
    ]
      .filter(Boolean)
      .join('\n')
      .trim(),
  }));
  return { pieces, splitInto };
}

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/\s+/g, '_').trim();
}

// Accepts both the standard column names and the aliases used by the merged
// FYP datasets:
//   Questions        → question
//   Answers          → answer
//   Model Name       → llm_name   (which AI generated the row — NOT a topic)
//   Source Reference → start_time (e.g. "Transcript — 00:14", "Title slide")
function normaliseRow(r: Record<string, unknown>): RawRow {
  const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [normaliseKey(k), v]));
  if (!('question'   in n) && 'questions'        in n) n['question']   = n['questions'];
  if (!('answer'     in n) && 'answers'          in n) n['answer']     = n['answers'];
  if (!('llm_name'   in n) && 'model_name'       in n) n['llm_name']   = n['model_name'];
  if (!('start_time' in n) && 'source_reference' in n) n['start_time'] = n['source_reference'];
  if (!('qa_id'      in n) && 'qaid'             in n) n['qa_id']      = n['qaid'];
  return n as RawRow;
}

// Parses the xlsx buffer and returns validated rows. The work is bounded before
// it starts (it runs on the shared request thread, dry runs included): the zip
// is checked against the decompressed-size limit, only the dataset sheet is
// parsed, and parsing stops one row past the row limit.
export function parseExcel(buffer: Buffer): RawRow[] {
  const lim = env.DATASET;
  assertSafeXlsx(buffer, { maxUncompressedBytes: lim.MAX_UNCOMPRESSED_BYTES, maxEntries: lim.MAX_ZIP_ENTRIES });

  // Sheet names first (a few ms), so only the dataset sheet is parsed below:
  // reading every sheet of an audit workbook costs about 4× as much.
  let names: string[];
  try {
    names = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  } catch {
    throw new AppError('The file is not a valid .xlsx workbook.', 400);
  }
  if (names.length === 0) throw new AppError('Excel file is empty', 400);
  // The audit workbooks carry several sheets; the dataset is on Final_Dataset.
  const sheetName = names.find(n => n.trim().toLowerCase() === 'final_dataset') ?? names[0];
  // Header + MAX_ROWS rows + one more, to tell "exactly at the limit" from "over it".
  const workbook = XLSX.read(buffer, { type: 'buffer', sheets: [sheetName], sheetRows: lim.MAX_ROWS + 2, cellHTML: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) throw new AppError('Excel file is empty', 400);

  // Only the first MAX_COLUMNS columns become row fields; the importer uses ten
  // at most. (A stray cell far to the right would otherwise make every row that
  // wide.) The parser above still reads the sheet's cells; sheetRows is what
  // bounds that work.
  const ref = XLSX.utils.decode_range(sheet['!ref']);
  ref.e.c = Math.min(ref.e.c, ref.s.c + lim.MAX_COLUMNS - 1);
  const rawRows  = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', range: ref });
  // Blank rows are not counted, so empty formatted rows below the data never trip this.
  if (rawRows.length > lim.MAX_ROWS) {
    throw new AppError(`The sheet "${sheetName}" has more than ${lim.MAX_ROWS.toLocaleString()} rows of data (the limit). Split it into smaller files, or raise DATASET_MAX_ROWS on the server.`, 400);
  }

  if (rawRows.length === 0) throw new AppError('Excel file is empty', 400);

  // The real 1-based spreadsheet row of each record (sheet_to_json skips blank
  // rows, so the array index alone is wrong once there is a gap).
  const rows = rawRows.map(r => {
    const n = normaliseRow(r);
    const rowNum = (r as { __rowNum__?: number }).__rowNum__;
    if (typeof rowNum === 'number') Object.defineProperty(n, SHEET_ROW, { value: rowNum + 1, enumerable: false });
    return n;
  });

  // Validate required columns exist in first row
  const first = rows[0];
  const missing: string[] = [];
  // `topic` is intentionally NOT required: the merged datasets have no topic
  // column, and the LLM name previously mapped into it was noise, not a topic.
  if (!('question' in first)) missing.push('question (or Questions)');
  if (!('answer'   in first)) missing.push('answer (or Answers)');
  if (missing.length > 0) {
    throw new AppError(`Missing required column(s): ${missing.join(', ')}`, 400);
  }

  return rows;
}

export interface SkippedRow { sheetRow: number; reason: 'EMPTY_QUESTION' | 'EMPTY_ANSWER' }

// Validates the parsed rows and converts them to the normalised shape the
// dataset planner works on. Rows with an empty question or answer are skipped
// (logged, and returned in `skipped` so the upload preview can show them).
// `sheetRow` is the 1-based spreadsheet row (header = row 1) so messages can
// point at the right line.
export function toFileRows(rows: RawRow[]): FileRow[] {
  return toFileRowsReport(rows).rows;
}

export function toFileRowsReport(rows: RawRow[]): { rows: FileRow[]; skipped: SkippedRow[] } {
  const out: FileRow[] = [];
  const skipped: SkippedRow[] = [];
  const clean = (v: unknown): string | null => String(v ?? '').trim() || null;
  rows.forEach((row, i) => {
    const sheetRow = (row as { [SHEET_ROW]?: number })[SHEET_ROW] ?? i + 2;
    const q = String(row.question ?? '').trim();
    const a = String(row.answer   ?? '').trim();
    if (!q) { logger.warn(`[DATASET] ⚠️  Skipping row ${sheetRow}: empty question`); skipped.push({ sheetRow, reason: 'EMPTY_QUESTION' }); return; }
    if (!a) { logger.warn(`[DATASET] ⚠️  Skipping row ${sheetRow}: empty answer`);   skipped.push({ sheetRow, reason: 'EMPTY_ANSWER' });   return; }
    out.push({
      qaId:       clean(row.qa_id),
      sheetRow,
      topic:      clean(row.topic),
      question:   q,
      answer:     a,
      start_time: clean(row.start_time),
      end_time:   clean(row.end_time),
      keywords:   clean(row.keywords),
      llm_name:   clean(row.llm_name),
    });
  });
  return { rows: out, skipped };
}

// Full pipeline: parse → plan against the active dataset → build a new
// version → embed only what is missing → validate → publish. Kept as a thin
// wrapper so existing callers (seed-dataset) keep working; the real logic is
// in dataset-version.service.ts.
export async function processDataset(
  lectureId: number,
  buffer: Buffer,
  options: { mode?: 'MERGE' | 'REPLACE'; confirmRemovals?: number; filename?: string } = {}
): Promise<void> {
  const { prepareDatasetVersion, finishDatasetVersion } = await import('./dataset-version.service');
  const prepared = await prepareDatasetVersion(lectureId, buffer, options);
  if (prepared.kind !== 'CREATED') return; // no changes (or dry run): nothing to embed
  const result = await finishDatasetVersion(prepared.versionId);
  if (result.outcome === 'FAILED') {
    throw new AppError(`Dataset update failed: ${result.error ?? 'unknown error'}`, 500);
  }
}
