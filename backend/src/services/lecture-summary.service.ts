import pool, { query } from '../config/database';
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

// The exact text one chunk contributes to a summary prompt. Batches are sized
// on this, not on chunk_text: only chunk_index = 0 rows are summarised, and for
// a split row chunk_text holds just its first piece while answer holds the
// whole answer, so sizing on chunk_text let a batch run ~20x over budget.
export const summaryEntryText = (c: Pick<QnaChunk, 'topic' | 'question' | 'answer'>): string =>
  `Topic: ${c.topic ?? 'General'}\nQ: ${c.question}\nA: ${c.answer}`;
const ENTRY_SEPARATOR = '\n\n';
const entryCost = (c: QnaChunk): number => summaryEntryText(c).length + ENTRY_SEPARATOR.length;

// An entry that is over budget on its own gets its answer cut (with an
// ellipsis) so that it fits; it then always travels in a batch by itself.
const fitToBudget = (c: QnaChunk, maxChars: number): QnaChunk => {
  if (entryCost(c) <= maxChars) return c;
  const overhead = entryCost({ ...c, answer: '' });
  const keep = Math.max(0, maxChars - overhead - 1);
  return { ...c, answer: `${c.answer.slice(0, keep)}…` };
};

// Pure — safe to unit-test without hitting the network or DB. No batch's
// summed entryCost exceeds maxChars.
export const buildSummaryBatches = (chunks: QnaChunk[], maxChars = MAX_CHARS_PER_BATCH): QnaChunk[][] => {
  const batches: QnaChunk[][] = [];
  let current: QnaChunk[] = [];
  let currentChars = 0;

  for (const original of chunks) {
    const chunk = fitToBudget(original, maxChars);
    const cost = entryCost(chunk);
    if (current.length > 0 && currentChars + cost > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += cost;
  }
  if (current.length > 0) batches.push(current);

  return batches;
};

const DEFAULT_SUMMARY_TIMEOUT_MS = 20000;

/**
 * How many batch summaries are in flight at once.
 *
 * They used to run strictly one after another, so a lecture that split into
 * ten batches cost ten round trips end to end: measured at 130 s typical,
 * 186 s at worst, with a student watching. Nothing about a batch depends on
 * another batch — each one is summarised only from its own content — so the
 * sequence bought nothing.
 *
 * Four at a time, not all of them: a provider rate limit turns an unbounded
 * fan-out into a wall of 429s, which is slower than the sequence it replaced
 * and fails instead of waiting.
 */
export const SUMMARY_BATCH_CONCURRENCY = 4;

/**
 * Run `work` over `items` with at most `limit` in flight, keeping results in
 * the order the items came in. Order matters here: the partial summaries are
 * labelled "Section 1", "Section 2" for the combine step, and shuffling them
 * would reorder the lecture.
 */
async function mapWithLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

const SUMMARY_SYSTEM_PROMPT = `You are summarizing part of a lecture for a student-facing AI tutor.
Use ONLY the lecture content provided below. Do NOT use outside knowledge, and do NOT invent facts that aren't present in it.
Produce a concise, well-organized summary of the topics and key points covered in this content.`;

const summarizeBatchWithGemini = async (
  chunks: QnaChunk[],
  lectureTitle: string,
  timeoutMs: number
): Promise<string | null> => {
  try {
    const content = chunks.map(summaryEntryText).join(ENTRY_SEPARATOR);
    const prompt = `Lecture: "${lectureTitle}"\n\nContent:\n${content}`;

    const provider = resolveLlmProvider(env.LLM.LECTURE_SUMMARY.PROVIDER);
    const model = env.LLM.LECTURE_SUMMARY.MODEL;
    const result = await withLlmDiagnostic(
      {
        spanName: 'summary_batch_call',
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
        spanName: 'summary_combine_call',
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

/**
 * The stored summary for a specific immutable dataset version, if current.
 *
 * `versionId` is normally null: the lecture's active version is resolved in
 * SQL, exactly as getAllLectureChunks resolves it, so the summary that comes
 * back is always the one built from the chunks that would be summarised now.
 */
export const getStoredLectureSummary = async (
  lectureId: number, versionId?: number | null
): Promise<string | null> => {
  try {
    const { rows } = await query<{ summary: string }>(
      `SELECT v.lecture_summary AS summary
         FROM dataset_versions v
        WHERE v.lecture_id = $1
          AND v.id = COALESCE($2::int, (SELECT active_version_id FROM lectures WHERE id = $1))
          AND v.lecture_summary IS NOT NULL
          AND v.summary_provider = $3 AND v.summary_model = $4
          AND v.summary_prompt_version = $5`,
      [lectureId, versionId ?? null, env.LLM.LECTURE_SUMMARY.PROVIDER,
        env.LLM.LECTURE_SUMMARY.MODEL, env.LLM.LECTURE_SUMMARY.PROMPT_VERSION]
    );
    return rows[0]?.summary ?? null;
  } catch (err) {
    // A cache that cannot be read must never stop an answer being produced.
    logger.warn(`[LECTURE-SUMMARY] ⚠️  Could not read stored summary for lecture #${lectureId}: ${(err as Error).message}`);
    return null;
  }
};

/**
 * Keep a summary for next time. Only ever called with a complete one: a
 * partial summary carries a note saying part of the lecture is missing, and
 * storing that would freeze a temporary outage into the lecture for good.
 */
export const storeLectureSummary = async (
  lectureId: number, versionId: number | null, summary: string, batchCount: number
): Promise<void> => {
  try {
    await query(
      `UPDATE dataset_versions
          SET lecture_summary = $3,
              summary_batch_count = $4,
              summary_provider = $5,
              summary_model = $6,
              summary_prompt_version = $7,
              summary_generated_at = NOW()
        WHERE lecture_id = $1
          AND id = COALESCE($2::int, (SELECT active_version_id FROM lectures WHERE id = $1))`,
      [lectureId, versionId ?? null, summary, batchCount, env.LLM.LECTURE_SUMMARY.PROVIDER,
        env.LLM.LECTURE_SUMMARY.MODEL, env.LLM.LECTURE_SUMMARY.PROMPT_VERSION]
    );
  } catch (err) {
    // Same again: failing to keep it costs the next student time, nothing more.
    logger.warn(`[LECTURE-SUMMARY] ⚠️  Could not store summary for lecture #${lectureId}: ${(err as Error).message}`);
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

  const settled = await mapWithLimit(batches, SUMMARY_BATCH_CONCURRENCY,
    (batch) => summarizeBatch(batch, lectureTitle, timeoutMs));
  // A failed batch yields null and is dropped; the survivors keep their
  // original order, so "Section 2" is still the second part of the lecture.
  const partials = settled.filter((p): p is string => !!p);
  const counts = { batchesAttempted: batches.length, batchesSucceeded: partials.length };
  if (partials.length < batches.length) {
    logger.warn(`[LECTURE-SUMMARY] ⚠️  ${batches.length - partials.length}/${batches.length} batch(es) failed`);
  }

  if (partials.length === 0) return { summary: null, ...counts };
  if (partials.length === 1) return { summary: partials[0], ...counts };

  return { summary: await combineSummaries(partials, lectureTitle, timeoutMs), ...counts };
};

type SummaryGenerator = typeof generateLectureSummary;
export interface PreparedLectureSummary {
  result: LectureSummaryResult;
  stored: boolean;
}

// If a student asks while upload-time generation is still running, both paths
// share this promise rather than paying for a second generation on this API
// process. The durable database row is scoped to lecture + dataset version +
// provider + model + prompt version.
const summaryInFlight = new Map<string, Promise<PreparedLectureSummary>>();

export const prepareLectureSummary = async (
  lectureId: number,
  versionId: number | null | undefined,
  lectureTitle: string,
  chunks: QnaChunk[],
  generator: SummaryGenerator = generateLectureSummary
): Promise<PreparedLectureSummary> => {
  const cached = await getStoredLectureSummary(lectureId, versionId);
  if (cached) {
    return { result: { summary: cached, batchesAttempted: 0, batchesSucceeded: 0 }, stored: true };
  }

  const resolvedVersionId = versionId ?? await getActiveLectureVersionId(lectureId);
  if (resolvedVersionId === null) {
    return { result: await generator(chunks, lectureTitle), stored: false };
  }

  const key = `${lectureId}:${resolvedVersionId}:${env.LLM.LECTURE_SUMMARY.PROVIDER}:${env.LLM.LECTURE_SUMMARY.MODEL}:${env.LLM.LECTURE_SUMMARY.PROMPT_VERSION}`;
  let job = summaryInFlight.get(key);
  if (!job) {
    job = (async () => {
      // The PostgreSQL session lock coordinates warm-up across API replicas.
      // Once acquired, recheck the row because another process may have just
      // completed the same version/configuration.
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`lecture-summary:${lectureId}:${resolvedVersionId}`]);
        const afterLock = await getStoredLectureSummary(lectureId, resolvedVersionId);
        if (afterLock) {
          return { result: { summary: afterLock, batchesAttempted: 0, batchesSucceeded: 0 }, stored: true };
        }
        const result = await generator(chunks, lectureTitle);
        if (result.summary && result.batchesSucceeded === result.batchesAttempted) {
          await storeLectureSummary(lectureId, resolvedVersionId, result.summary, result.batchesAttempted);
        }
        return { result, stored: false };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`lecture-summary:${lectureId}:${resolvedVersionId}`]).catch(() => undefined);
        client.release();
      }
    })().finally(() => summaryInFlight.delete(key));
    summaryInFlight.set(key, job);
  }
  return job;
};

const getActiveLectureVersionId = async (lectureId: number): Promise<number | null> => {
  const { rows } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1', [lectureId]
  );
  return rows[0]?.active_version_id ?? null;
};

/** Build and persist the active version's summary outside the upload request. */
export const warmLectureSummary = async (lectureId: number, versionId: number): Promise<void> => {
  const cached = await getStoredLectureSummary(lectureId, versionId);
  if (cached) return;
  const [{ rows: lectureRows }, chunks] = await Promise.all([
    query<{ title: string }>('SELECT title FROM lectures WHERE id = $1', [lectureId]),
    getAllLectureChunks(lectureId, versionId),
  ]);
  if (!lectureRows[0] || chunks.length === 0) {
    logger.warn(`[LECTURE-SUMMARY] No title/content for lecture #${lectureId} version #${versionId}`);
    return;
  }
  const { result } = await prepareLectureSummary(lectureId, versionId, lectureRows[0].title, chunks);
  const complete = !!result.summary && result.batchesSucceeded === result.batchesAttempted;
  logger.info(`[LECTURE-SUMMARY] Background warm-up ${complete ? 'completed' : 'incomplete'} for lecture #${lectureId} version #${versionId}`);
};

/**
 * Recover after restarts and rebuild summaries when provider, model, or prompt
 * version changes. Only ACTIVE dataset versions are considered.
 */
export const warmMissingLectureSummaries = async (): Promise<number> => {
  const { rows } = await query<{ lecture_id: number; version_id: number }>(
    `SELECT l.id AS lecture_id, v.id AS version_id
       FROM lectures l
       JOIN dataset_versions v ON v.id = l.active_version_id AND v.lecture_id = l.id
      WHERE l.active_version_id IS NOT NULL
        AND (v.lecture_summary IS NULL
          OR v.summary_provider IS DISTINCT FROM $1
          OR v.summary_model IS DISTINCT FROM $2
          OR v.summary_prompt_version IS DISTINCT FROM $3)
      ORDER BY l.id`,
    [env.LLM.LECTURE_SUMMARY.PROVIDER, env.LLM.LECTURE_SUMMARY.MODEL,
      env.LLM.LECTURE_SUMMARY.PROMPT_VERSION]
  );
  let warmed = 0;
  for (const item of rows) {
    try {
      await warmLectureSummary(item.lecture_id, item.version_id);
      warmed += 1;
    } catch (err) {
      logger.warn(`[LECTURE-SUMMARY] Background warm-up failed for lecture #${item.lecture_id} version #${item.version_id}: ${(err as Error).message}`);
    }
  }
  return warmed;
};
