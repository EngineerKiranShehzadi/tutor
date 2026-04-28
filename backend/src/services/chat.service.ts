import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { ChatHistoryEntry, QnaChunk } from '../types';
import { getLectureById } from './lecture.service';
import { logger } from '../utils/logger';

// ── GET CHAT HISTORY ───────────────────────────────────────────
// Returns only non-cleared entries for this student + lecture
export const getChatHistory = async (
  studentId: string,
  lectureId: number
): Promise<ChatHistoryEntry[]> => {
  const { rows } = await query<ChatHistoryEntry>(
    `SELECT ch.*, COALESCE(
       (SELECT json_agg(json_build_object(
         'id', c.id, 'topic', c.topic, 'question', c.question,
         'start_time', c.start_time, 'end_time', c.end_time
       ))
        FROM lecture_qna_chunks c
        WHERE c.id = ANY(ch.source_chunk_ids)
       ), '[]'::json
     ) AS sources_detail
     FROM chat_history ch
     WHERE ch.student_id = $1
       AND ch.lecture_id = $2
       AND ch.cleared_by_student = FALSE
     ORDER BY ch.created_at ASC`,
    [studentId, lectureId]
  );
  logger.info(`[CHAT] Fetched ${rows.length} history entries for student ${studentId} lecture ${lectureId}`);
  return rows;
};

// ── SAVE CHAT ENTRY ────────────────────────────────────────────
export const saveChatEntry = async (params: {
  studentId:      string;
  lectureId:      number;
  question:       string;
  answer:         string;
  sourceChunkIds: number[];
}): Promise<number> => {
  const { studentId, lectureId, question, answer, sourceChunkIds } = params;

  // Also save to student_questions for admin analytics
  await query(
    'INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)',
    [studentId, lectureId, question]
  );

  const { rows } = await query<{ id: number }>(
    `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [studentId, lectureId, question, answer, sourceChunkIds]
  );

  logger.info(`[CHAT] ✅ Saved chat entry #${rows[0].id} for lecture ${lectureId}`);
  return rows[0].id;
};

// ── CLEAR CHAT (soft delete) ───────────────────────────────────
export const clearChat = async (studentId: string, lectureId: number): Promise<void> => {
  const { rowCount } = await query(
    `UPDATE chat_history
     SET cleared_by_student = TRUE
     WHERE student_id = $1 AND lecture_id = $2 AND cleared_by_student = FALSE`,
    [studentId, lectureId]
  );
  logger.info(`[CHAT] 🧹 Cleared ${rowCount ?? 0} chat entries for student ${studentId} lecture ${lectureId}`);
};

// ── ASK LECTURE AGENT (orchestrator) ──────────────────────────
// Real RAG runs here — embedding + vector search + LLM
// Returns answer + source chunks
export const askLectureAgent = async (params: {
  studentId: string;
  lectureId: number;
  question:  string;
}): Promise<{ answer: string; sources: QnaChunk[] }> => {
  const { studentId, lectureId, question } = params;

  // 1. Confirm lecture exists and is READY
  const lecture = await getLectureById(lectureId);
  if (lecture.status !== 'READY') {
    logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} is not READY (status=${lecture.status})`);
    throw new AppError('AI tutor is not ready for this lecture yet. Please wait for the dataset to be processed.', 400);
  }

  // 2. Import embedding + vector search + LLM lazily so missing API key gives a clean error
  const { generateEmbedding } = await import('./embedding.service');
  const { searchChunks }      = await import('./vector-search.service');
  const { generateAnswer }    = await import('./llm-gemini.service');

  // 3. Embed the student question
  logger.info(`[CHAT] 🔍 Embedding question for lecture #${lectureId}: "${question.slice(0, 60)}..."`);
  const questionEmbedding = await generateEmbedding(question);

  // 4. Vector search — lecture-scoped
  const chunks = await searchChunks(questionEmbedding, lectureId, 5);
  if (chunks.length === 0) {
    logger.warn(`[CHAT] ⚠️  No relevant chunks found for question in lecture #${lectureId}`);
    const fallback = 'I could not find this information in the selected lecture. Please rephrase your question or ask about a different topic from this lecture.';
    await saveChatEntry({ studentId, lectureId, question, answer: fallback, sourceChunkIds: [] });
    return { answer: fallback, sources: [] };
  }

  logger.info(`[CHAT] ✅ Found ${chunks.length} relevant chunks (top similarity=${chunks[0].similarity?.toFixed(3)})`);

  // 5. LLM answer generation
  const answer = await generateAnswer(question, chunks, lecture.title);

  // 6. Save to DB
  const chunkIds = chunks.map((c: QnaChunk) => c.id);
  await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: chunkIds });

  logger.info(`[CHAT] ✅ Answer generated and saved for lecture #${lectureId}`);
  return { answer, sources: chunks };
};
