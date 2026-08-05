import { query } from '../config/database';
import { QnaChunk } from '../types';
import { getClient } from './llm-gemini.service';
import { logger } from '../utils/logger';
import { withGeminiDiagnostic } from '../observability/gemini-diagnostics';

export const LECTURE_SUMMARY_UNAVAILABLE_MESSAGE =
  'I could not generate a summary for this lecture right now.';

// Fetches every chunk for the lecture in stored/insertion order (chunks are
// inserted row-by-row in dataset order during processing — see
// chunk.service.ts — which mirrors the lecture's logical/topic order).
// Deliberately bypasses vector search: a summary must represent the whole
// lecture, not just the chunks most similar to the word "summary".
export const getAllLectureChunks = async (lectureId: number): Promise<QnaChunk[]> => {
  const { rows } = await query<QnaChunk>(
    `SELECT id, lecture_id, topic, question, answer, chunk_text, start_time, end_time, keywords
     FROM lecture_qna_chunks
     WHERE lecture_id = $1
     ORDER BY id ASC`,
    [lectureId]
  );
  return rows;
};

// Conservative per-request character budget — keeps each batch call fast
// and comfortably within context limits regardless of lecture length.
export const MAX_CHARS_PER_BATCH = 12000;

// Pure — safe to unit-test without hitting the network or DB.
export const buildSummaryBatches = (chunks: QnaChunk[], maxChars = MAX_CHARS_PER_BATCH): QnaChunk[][] => {
  const batches: QnaChunk[][] = [];
  let current: QnaChunk[] = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    const len = chunk.chunk_text.length;
    if (current.length > 0 && currentChars + len > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += len;
  }
  if (current.length > 0) batches.push(current);

  return batches;
};

const DEFAULT_SUMMARY_TIMEOUT_MS = 20000;

const SUMMARY_SYSTEM_PROMPT = `You are summarizing part of a lecture for a student-facing AI tutor.
Use ONLY the lecture content provided below. Do NOT use outside knowledge, and do NOT invent facts that aren't present in it.
Produce a concise, well-organized summary of the topics and key points covered in this content.`;

const summarizeBatchWithGemini = async (
  chunks: QnaChunk[],
  lectureTitle: string,
  timeoutMs: number
): Promise<string | null> => {
  try {
    const genAI = getClient();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SUMMARY_SYSTEM_PROMPT,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    });
    const content = chunks.map(c => `Topic: ${c.topic ?? 'General'}\nQ: ${c.question}\nA: ${c.answer}`).join('\n\n');
    const prompt = `Lecture: "${lectureTitle}"\n\nContent:\n${content}`;

    const result = await withGeminiDiagnostic(
      {
        spanName: 'gemini_summary_batch_call',
        operationType: 'PARTIAL_SUMMARY',
        model: 'gemini-2.5-flash',
        validContextSupplied: chunks.length > 0,
        invocationParams: { temperature: 0.3, maxOutputTokens: 1024, timeoutMs },
      },
      () => model.generateContent(prompt, { timeout: timeoutMs }),
      r => ({
        input: r.response.usageMetadata?.promptTokenCount,
        output: r.response.usageMetadata?.candidatesTokenCount,
        finishReason: r.response.candidates?.[0]?.finishReason,
      })
    );
    const text = result.response.text()?.trim();
    return text || null;
  } catch (err) {
    logger.warn(`[LECTURE-SUMMARY] ⚠️  Batch summarization failed: ${(err as Error).message}`);
    return null;
  }
};

const COMBINE_SYSTEM_PROMPT = `You are combining partial section summaries of a lecture into one final summary for a student.
Use ONLY the partial summaries provided below. Do NOT use outside knowledge, and do NOT invent facts not present in them.
Produce one cohesive, well-organized summary covering the whole lecture.`;

const combineSummariesWithGemini = async (
  partials: string[],
  lectureTitle: string,
  timeoutMs: number
): Promise<string | null> => {
  try {
    const genAI = getClient();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: COMBINE_SYSTEM_PROMPT,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1536 },
    });
    const sections = partials.map((p, i) => `Section ${i + 1} summary:\n${p}`).join('\n\n');
    const prompt = `Lecture: "${lectureTitle}"\n\n${sections}`;

    const result = await withGeminiDiagnostic(
      {
        spanName: 'gemini_summary_combine_call',
        operationType: 'FINAL_SUMMARY',
        model: 'gemini-2.5-flash',
        validContextSupplied: partials.length > 0,
        invocationParams: { temperature: 0.3, maxOutputTokens: 1536, timeoutMs },
      },
      () => model.generateContent(prompt, { timeout: timeoutMs }),
      r => ({
        input: r.response.usageMetadata?.promptTokenCount,
        output: r.response.usageMetadata?.candidatesTokenCount,
        finishReason: r.response.candidates?.[0]?.finishReason,
      })
    );
    const text = result.response.text()?.trim();
    return text || null;
  } catch (err) {
    logger.warn(`[LECTURE-SUMMARY] ⚠️  Combining partial summaries failed: ${(err as Error).message}`);
    return null;
  }
};

export interface SummarizeDeps {
  summarizeBatch?:    (chunks: QnaChunk[], lectureTitle: string, timeoutMs: number) => Promise<string | null>;
  combineSummaries?:  (partials: string[], lectureTitle: string, timeoutMs: number) => Promise<string | null>;
}

// Hierarchical summarization: batches that fit a single request are
// summarized directly; multiple batches are summarized independently
// (grounded only in their own content) and then combined into one final,
// still strictly-grounded summary. Returns null if there's no content or
// every batch failed — caller is responsible for the user-facing fallback.
export const generateLectureSummary = async (
  chunks: QnaChunk[],
  lectureTitle: string,
  deps: SummarizeDeps = {},
  opts: { timeoutMs?: number; maxCharsPerBatch?: number } = {}
): Promise<string | null> => {
  if (chunks.length === 0) return null;

  const summarizeBatch   = deps.summarizeBatch   ?? summarizeBatchWithGemini;
  const combineSummaries = deps.combineSummaries ?? combineSummariesWithGemini;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;

  const batches = buildSummaryBatches(chunks, opts.maxCharsPerBatch ?? MAX_CHARS_PER_BATCH);
  logger.info(`[LECTURE-SUMMARY] 📚 Summarizing ${chunks.length} chunk(s) in ${batches.length} batch(es)`);

  if (batches.length === 1) {
    return summarizeBatch(batches[0], lectureTitle, timeoutMs);
  }

  const partials: string[] = [];
  for (const batch of batches) {
    const partial = await summarizeBatch(batch, lectureTitle, timeoutMs);
    if (partial) partials.push(partial);
  }

  if (partials.length === 0) return null;
  if (partials.length === 1) return partials[0];

  return combineSummaries(partials, lectureTitle, timeoutMs);
};
