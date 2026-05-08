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

// ── PAGINATED CHAT HISTORY ────────────────────────────────────────
const SOURCES_SQL = `COALESCE(
  (SELECT json_agg(json_build_object(
     'id', c.id, 'topic', c.topic, 'question', c.question,
     'start_time', c.start_time, 'end_time', c.end_time
   ))
   FROM lecture_qna_chunks c
   WHERE c.id = ANY(ch.source_chunk_ids)
  ), '[]'::json
) AS sources_detail`;

export const getPaginatedChatHistory = async (
  studentId: string,
  lectureId: number,
  limit: number,
  offset: number
): Promise<{ entries: ChatHistoryEntry[]; total: number }> => {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query<ChatHistoryEntry>(
      `SELECT ch.*, ${SOURCES_SQL}
       FROM chat_history ch
       WHERE ch.student_id = $1 AND ch.lecture_id = $2 AND ch.cleared_by_student = FALSE
       ORDER BY ch.created_at DESC
       LIMIT $3 OFFSET $4`,
      [studentId, lectureId, limit, offset]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) FROM chat_history WHERE student_id = $1 AND lecture_id = $2 AND cleared_by_student = FALSE`,
      [studentId, lectureId]
    ),
  ]);
  return { entries: rows, total: parseInt(countRows[0].count, 10) };
};

export const searchChatHistory = async (
  studentId: string,
  lectureId: number,
  searchQuery: string
): Promise<ChatHistoryEntry[]> => {
  const { rows } = await query<ChatHistoryEntry>(
    `SELECT ch.*, ${SOURCES_SQL}
     FROM chat_history ch
     WHERE ch.student_id = $1
       AND ch.lecture_id = $2
       AND ch.cleared_by_student = FALSE
       AND (ch.question ILIKE $3 OR ch.answer ILIKE $3)
     ORDER BY ch.created_at DESC
     LIMIT 50`,
    [studentId, lectureId, `%${searchQuery}%`]
  );
  return rows;
};

// ── SAVE CHAT ENTRY ────────────────────────────────────────────
// Persists the completed Q&A pair to chat_history only.
// student_questions is written earlier in askLectureAgent (before the AI call)
// so analytics are preserved even if the LLM fails.
export const saveChatEntry = async (params: {
  studentId:      string;
  lectureId:      number;
  question:       string;
  answer:         string;
  sourceChunkIds: number[];
}): Promise<number> => {
  const { studentId, lectureId, question, answer, sourceChunkIds } = params;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [studentId, lectureId, question, answer, sourceChunkIds]
  );

  logger.info(`[CHAT] ✅ Saved chat entry #${rows[0].id} for lecture ${lectureId}`);
  return rows[0].id;
};

// ── DELETE SINGLE CHAT ENTRY ──────────────────────────────────
export const deleteChatEntry = async (studentId: string, entryId: number): Promise<boolean> => {
  const { rowCount } = await query(
    `UPDATE chat_history SET cleared_by_student = TRUE
     WHERE id = $1 AND student_id = $2 AND cleared_by_student = FALSE`,
    [entryId, studentId]
  );
  logger.info(`[CHAT] 🗑️  Deleted entry #${entryId} for student ${studentId} (affected=${rowCount ?? 0})`);
  return (rowCount ?? 0) > 0;
};

// ── RENAME CHAT ENTRY (display label) ─────────────────────────
export const renameChatEntry = async (studentId: string, entryId: number, label: string): Promise<boolean> => {
  const { rowCount } = await query(
    `UPDATE chat_history SET display_label = $3
     WHERE id = $1 AND student_id = $2 AND cleared_by_student = FALSE`,
    [entryId, studentId, label]
  );
  logger.info(`[CHAT] ✏️  Renamed entry #${entryId} to "${label.slice(0, 40)}"`);
  return (rowCount ?? 0) > 0;
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

  // 2. Persist the question for admin analytics NOW — before the AI call —
  //    so analytics are never lost even if Gemini fails.
  await query(
    'INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)',
    [studentId, lectureId, question]
  );

  // 3. Import embedding + vector search + LLM lazily so missing API key gives a clean error
  const { generateEmbedding } = await import('./embedding.service');
  const { searchChunks }      = await import('./vector-search.service');
  const { generateAnswer }    = await import('./llm-gemini.service');

  // 4. Load recent conversation history (last 10 turns) for context-aware answering.
  //    This lets the AI handle follow-up questions ("can you explain that more?").
  const recentHistory = await getChatHistory(studentId, lectureId);
  const historyTurns = recentHistory
    .slice(-10)
    .map(e => ({ question: e.question, answer: e.answer }));

  if (historyTurns.length > 0) {
    logger.info(`[CHAT] 📚 Passing ${historyTurns.length} prior turn(s) as context to LLM`);
  }

  // 5. Embed the student question
  logger.info(`[CHAT] 🔍 Embedding question for lecture #${lectureId}: "${question.slice(0, 60)}..."`);
  const questionEmbedding = await generateEmbedding(question);

  // 6. Vector search — lecture-scoped
  const chunks = await searchChunks(questionEmbedding, lectureId, 5);
  if (chunks.length === 0) {
    logger.warn(`[CHAT] ⚠️  No relevant chunks found for question in lecture #${lectureId}`);
    const fallback = 'I could not find this information in the selected lecture. Please rephrase your question or ask about a different topic from this lecture.';
    await saveChatEntry({ studentId, lectureId, question, answer: fallback, sourceChunkIds: [] });
    return { answer: fallback, sources: [] };
  }

  logger.info(`[CHAT] ✅ Found ${chunks.length} relevant chunks (top similarity=${chunks[0].similarity?.toFixed(3)})`);

  // 7. LLM answer generation with conversation history for follow-up awareness
  const answer = await generateAnswer(question, chunks, lecture.title, historyTurns);

  // 8. Save completed Q&A to chat_history
  const chunkIds = chunks.map((c: QnaChunk) => c.id);
  await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: chunkIds });

  logger.info(`[CHAT] ✅ Answer generated and saved for lecture #${lectureId}`);
  return { answer, sources: chunks };
};
