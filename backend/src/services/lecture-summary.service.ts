import { query } from '../config/database';
import { QnaChunk } from '../types';
import { env } from '../config/env';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../llm/llm-observability.service';
import { logger } from '../utils/logger';

export const LECTURE_SUMMARY_UNAVAILABLE_MESSAGE =
  'I could not generate a summary for this lecture right now.';

// Chunks exist but no summary could be produced (every batch failed, or the
// combine step failed): an outage, never "the lecture is empty".
export const LECTURE_SUMMARY_FAILED_MESSAGE =
  "I couldn't generate a summary of this lecture right now. Please try again in a moment.";

// Appended when only some batches were summarised, so a partial summary is
// never presented as the whole lecture.
export const PARTIAL_SUMMARY_NOTE =
  "\n\n_Part of this lecture couldn't be summarised right now — ask again for a complete summary._";

export interface LectureSummaryResult {
  // null when there was no content, or nothing could be summarised.
  summary: string | null;
  batchesAttempted: number;
  batchesSucceeded: number;
}

// Fetches one row per source Q&A for the lecture, in stored/insertion order
// (chunks are inserted row-by-row in dataset order during processing — see
// chunk.service.ts — which mirrors the lecture's logical/topic order).
// Deliberately bypasses vector search: a summary must represent the whole
// lecture, not just the chunks most similar to the word "summary".
//
// chunk_index = 0 only: a long answer can be split into several embedded
// chunks (chunk.service.ts), all sharing the same full question/answer
// text. This function reads question/answer directly rather than
// chunk_text, so without this filter a split row's full Q&A would appear
// in the summary input once per piece — inflating the summary's input
// size and repeating the same content back to Gemini for no benefit.
export const getAllLectureChunks = async (lectureId: number, datasetVersionId?: number): Promise<QnaChunk[]> => {
  const { rows } = await query<QnaChunk>(
    `SELECT id, lecture_id, topic, question, answer, chunk_text, start_time, end_time, keywords
     FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND chunk_index = 0
       AND id IN (SELECT chunk_id FROM dataset_version_chunks
                  WHERE version_id = COALESCE($2::int, (SELECT active_version_id FROM lectures WHERE id = $1)))
     ORDER BY id ASC`,
    [lectureId, datasetVersionId ?? null]
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
    const content = chunks.map(c => `Topic: ${c.topic ?? 'General'}\nQ: ${c.question}\nA: ${c.answer}`).join('\n\n');
    const prompt = `Lecture: "${lectureTitle}"\n\nContent:\n${content}`;

    const provider = resolveLlmProvider(env.LLM.LECTURE_SUMMARY.PROVIDER);
    const model = env.LLM.LECTURE_SUMMARY.MODEL;
    const result = await withLlmDiagnostic(
      {
        spanName: 'gemini_summary_batch_call',
        operationType: 'PARTIAL_SUMMARY',
        provider: provider.name,
        model,
        validContextSupplied: chunks.length > 0,
        invocationParams: { temperature: 0.3, maxOutputTokens: 1024, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: prompt,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        temperature: 0.3,
        maxOutputTokens: 1024,
        thinking: env.LLM.LECTURE_SUMMARY.THINKING,
        timeoutMs,
      }),
      extractLlmUsage
    );
    const text = result.raw?.trim();
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
    const sections = partials.map((p, i) => `Section ${i + 1} summary:\n${p}`).join('\n\n');
    const prompt = `Lecture: "${lectureTitle}"\n\n${sections}`;

    const provider = resolveLlmProvider(env.LLM.LECTURE_SUMMARY.PROVIDER);
    const model = env.LLM.LECTURE_SUMMARY.MODEL;
    const result = await withLlmDiagnostic(
      {
        spanName: 'gemini_summary_combine_call',
        operationType: 'FINAL_SUMMARY',
        provider: provider.name,
        model,
        validContextSupplied: partials.length > 0,
        invocationParams: { temperature: 0.3, maxOutputTokens: 1536, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: prompt,
        systemPrompt: COMBINE_SYSTEM_PROMPT,
        temperature: 0.3,
        maxOutputTokens: 1536,
        thinking: env.LLM.LECTURE_SUMMARY.THINKING,
        timeoutMs,
      }),
      extractLlmUsage
    );
    const text = result.raw?.trim();
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
// still strictly-grounded summary. summary is null if there's no content or
// nothing could be summarised; batchesAttempted/batchesSucceeded let the
// caller tell an empty lecture, an outage and a partial summary apart.
export const generateLectureSummary = async (
  chunks: QnaChunk[],
  lectureTitle: string,
  deps: SummarizeDeps = {},
  opts: { timeoutMs?: number; maxCharsPerBatch?: number } = {}
): Promise<LectureSummaryResult> => {
  if (chunks.length === 0) return { summary: null, batchesAttempted: 0, batchesSucceeded: 0 };

  const summarizeBatch   = deps.summarizeBatch   ?? summarizeBatchWithGemini;
  const combineSummaries = deps.combineSummaries ?? combineSummariesWithGemini;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;

  const batches = buildSummaryBatches(chunks, opts.maxCharsPerBatch ?? MAX_CHARS_PER_BATCH);
  logger.info(`[LECTURE-SUMMARY] 📚 Summarizing ${chunks.length} chunk(s) in ${batches.length} batch(es)`);

  const partials: string[] = [];
  for (const batch of batches) {
    const partial = await summarizeBatch(batch, lectureTitle, timeoutMs);
    if (partial) partials.push(partial);
  }
  const counts = { batchesAttempted: batches.length, batchesSucceeded: partials.length };
  if (partials.length < batches.length) {
    logger.warn(`[LECTURE-SUMMARY] ⚠️  ${batches.length - partials.length}/${batches.length} batch(es) failed`);
  }

  if (partials.length === 0) return { summary: null, ...counts };
  if (partials.length === 1) return { summary: partials[0], ...counts };

  return { summary: await combineSummaries(partials, lectureTitle, timeoutMs), ...counts };
};
