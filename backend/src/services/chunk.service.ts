import * as XLSX from 'xlsx';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { query } from '../config/database';
import { generateEmbedding } from './embedding.service';
import { updateLectureStatus, updateLectureProgress } from './lecture.service';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

interface RawRow {
  topic?: string;
  question?: string;
  answer?: string;
  start_time?: string;
  end_time?: string;
  keywords?: string;
  llm_name?: string;
}

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
  const whole = buildChunkText(row);
  if (whole.length <= SPLIT_THRESHOLD_CHARS) {
    return [{ chunkIndex: 0, chunkText: whole }];
  }

  const answer = String(row.answer ?? '');
  let parts: string[];
  try {
    parts = await splitter.splitText(answer);
  } catch (err) {
    logger.error('[CHUNK] ⚠️  Splitter failed, falling back to a single unsplit chunk', err);
    return [{ chunkIndex: 0, chunkText: whole }];
  }

  if (parts.length > MAX_PIECES_PER_ROW) {
    logger.warn(
      `[CHUNK] ⚠️  Row split into ${parts.length} pieces, exceeding the ${MAX_PIECES_PER_ROW}-piece cap — ` +
      `keeping the first ${MAX_PIECES_PER_ROW} and dropping the rest. Check this row's answer length.`
    );
    parts = parts.slice(0, MAX_PIECES_PER_ROW);
  }

  return parts.map((part, chunkIndex) => ({
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
  return n as RawRow;
}

// Parses the xlsx buffer and returns validated rows
export function parseExcel(buffer: Buffer): RawRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows  = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

  if (rawRows.length === 0) throw new AppError('Excel file is empty', 400);

  const rows = rawRows.map(normaliseRow);

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

// Full pipeline: parse → chunk → embed → store
export async function processDataset(lectureId: number, buffer: Buffer): Promise<void> {
  logger.info(`[DATASET] 🚀 Starting processing for lecture #${lectureId}`);

  let rows: RawRow[];
  try {
    rows = parseExcel(buffer);
    logger.info(`[DATASET] ✅ Parsed ${rows.length} rows from Excel`);
  } catch (err) {
    await updateLectureStatus(lectureId, 'FAILED', (err as Error).message);
    throw err;
  }

  // Validate row content
  const validRows: RawRow[] = [];
  rows.forEach((row, i) => {
    const q = String(row.question ?? '').trim();
    const a = String(row.answer   ?? '').trim();
    if (!q) { logger.warn(`[DATASET] ⚠️  Skipping row ${i + 2}: empty question`); return; }
    if (!a) { logger.warn(`[DATASET] ⚠️  Skipping row ${i + 2}: empty answer`);   return; }
    validRows.push({ ...row, question: q, answer: a });
  });

  if (validRows.length === 0) {
    await updateLectureStatus(lectureId, 'FAILED', 'All rows had empty question or answer');
    throw new AppError('No valid rows found in the dataset', 400);
  }

  // PROCESSING: delete old chunks, insert new ones without embeddings
  await updateLectureStatus(lectureId, 'PROCESSING');
  await query('DELETE FROM lecture_qna_chunks WHERE lecture_id = $1', [lectureId]);
  logger.info(`[DATASET] 🗑️  Cleared old chunks for lecture #${lectureId}`);

  await updateLectureProgress(lectureId, 0, validRows.length);
  // Each source row can now yield more than one DB row (chunk_index 0..N-1)
  // when its answer was long enough to split — chunkIds tracks every one of
  // them, in insertion order, alongside the exact chunkText each was built
  // from, so the embedding pass below embeds precisely what was stored.
  const chunkIds: number[] = [];
  const chunkTexts: string[] = [];
  const total = validRows.length;
  for (let i = 0; i < total; i++) {
    const row = validRows[i];
    const pieces = await buildChunkPieces(row);
    for (const piece of pieces) {
      const { rows: inserted } = await query<{ id: number }>(
        `INSERT INTO lecture_qna_chunks
           (lecture_id, topic, question, answer, chunk_text, chunk_index, start_time, end_time, keywords, llm_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          lectureId,
          String(row.topic      ?? '').trim() || null,
          String(row.question   ?? '').trim(),
          String(row.answer     ?? '').trim(),
          piece.chunkText,
          piece.chunkIndex,
          String(row.start_time ?? '').trim() || null,
          String(row.end_time   ?? '').trim() || null,
          String(row.keywords   ?? '').trim() || null,
          String(row.llm_name   ?? '').trim() || null,
        ]
      );
      chunkIds.push(inserted[0].id);
      chunkTexts.push(piece.chunkText);
    }
    if ((i + 1) % 500 === 0 || i + 1 === total) {
      logger.info(`[DATASET] 📥 Inserting chunks: ${i + 1}/${total} rows (${chunkIds.length} chunk(s) so far)`);
      await updateLectureProgress(lectureId, i + 1);
    }
  }
  logger.info(`[DATASET] ✅ Inserted ${chunkIds.length} chunk(s) from ${total} row(s) for lecture #${lectureId}`);

  // EMBEDDING: generate and store embeddings, one per chunk (not per row)
  await updateLectureStatus(lectureId, 'EMBEDDING');
  await updateLectureProgress(lectureId, 0, chunkIds.length);

  let embeddedCount = 0;
  for (let i = 0; i < chunkIds.length; i++) {
    try {
      const embedding = await generateEmbedding(chunkTexts[i]);
      const vectorLiteral = `[${embedding.join(',')}]`;
      await query(
        'UPDATE lecture_qna_chunks SET local_embedding = $1::vector WHERE id = $2',
        [vectorLiteral, chunkIds[i]]
      );
      embeddedCount++;
      await updateLectureProgress(lectureId, embeddedCount);
      logger.info(`[DATASET] Embedded chunk ${embeddedCount}/${chunkIds.length} (id=${chunkIds[i]})`);
    } catch (err) {
      logger.error(`[DATASET] ❌ Failed to embed chunk ${i + 1} (id=${chunkIds[i]})`, err);
    }
  }

  if (embeddedCount === 0) {
    await updateLectureStatus(lectureId, 'FAILED', 'All embeddings failed — is the embedding server running? python scripts/embedding_server.py');
    throw new AppError('Embedding generation failed for all chunks', 500);
  }

  await updateLectureStatus(lectureId, 'READY');
  logger.info(`[DATASET] 🎉 Lecture #${lectureId} is READY — ${embeddedCount}/${chunkIds.length} chunks embedded`);
}
