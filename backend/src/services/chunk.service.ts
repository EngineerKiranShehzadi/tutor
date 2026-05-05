import * as XLSX from 'xlsx';
import { query } from '../config/database';
import { generateEmbedding } from './embedding.service';
import { updateLectureStatus } from './lecture.service';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

interface RawRow {
  topic?: string;
  question?: string;
  answer?: string;
  start_time?: string;
  end_time?: string;
  keywords?: string;
}

function buildChunkText(row: RawRow): string {
  return [
    `Topic: ${row.topic ?? ''}`,
    `Question: ${row.question}`,
    `Answer: ${row.answer}`,
    row.keywords ? `Keywords: ${row.keywords}` : null,
    row.start_time ? `Timestamp: ${row.start_time} - ${row.end_time ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/\s+/g, '_').trim();
}

// Accepts both standard column names and the dataset.xlsx aliases:
//   Model → topic   |   Questions → question   |   Answers → answer
function normaliseRow(r: Record<string, unknown>): RawRow {
  const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [normaliseKey(k), v]));
  if (!('topic'    in n) && 'model'     in n) n['topic']    = n['model'];
  if (!('question' in n) && 'questions' in n) n['question'] = n['questions'];
  if (!('answer'   in n) && 'answers'   in n) n['answer']   = n['answers'];
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
  if (!('topic'    in first)) missing.push('topic (or Model)');
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

  const chunkIds: number[] = [];
  for (const row of validRows) {
    const chunkText = buildChunkText(row);
    const { rows: inserted } = await query<{ id: number }>(
      `INSERT INTO lecture_qna_chunks
         (lecture_id, topic, question, answer, chunk_text, start_time, end_time, keywords)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        lectureId,
        String(row.topic      ?? '').trim() || null,
        String(row.question   ?? '').trim(),
        String(row.answer     ?? '').trim(),
        chunkText,
        String(row.start_time ?? '').trim() || null,
        String(row.end_time   ?? '').trim() || null,
        String(row.keywords   ?? '').trim() || null,
      ]
    );
    chunkIds.push(inserted[0].id);
  }
  logger.info(`[DATASET] ✅ Inserted ${chunkIds.length} chunks for lecture #${lectureId}`);

  // EMBEDDING: generate and store embeddings
  await updateLectureStatus(lectureId, 'EMBEDDING');

  let embeddedCount = 0;
  for (let i = 0; i < validRows.length; i++) {
    try {
      const embedding = await generateEmbedding(buildChunkText(validRows[i]));
      const vectorLiteral = `[${embedding.join(',')}]`;
      await query(
        'UPDATE lecture_qna_chunks SET embedding = $1 WHERE id = $2',
        [vectorLiteral, chunkIds[i]]
      );
      embeddedCount++;
      logger.info(`[DATASET] Embedded chunk ${i + 1}/${validRows.length} (id=${chunkIds[i]})`);
      // Small delay to stay within Gemini free-tier rate limits
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      logger.error(`[DATASET] ❌ Failed to embed chunk ${i + 1} (id=${chunkIds[i]})`, err);
    }
  }

  if (embeddedCount === 0) {
    await updateLectureStatus(lectureId, 'FAILED', 'All embeddings failed — check GEMINI_API_KEY');
    throw new AppError('Embedding generation failed for all chunks', 500);
  }

  await updateLectureStatus(lectureId, 'READY');
  logger.info(`[DATASET] 🎉 Lecture #${lectureId} is READY — ${embeddedCount}/${validRows.length} chunks embedded`);
}
