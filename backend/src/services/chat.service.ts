import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { ChatHistoryEntry, QnaChunk } from '../types';
import { getLectureById } from './lecture.service';
import { logger } from '../utils/logger';

// ── Shared SQL fragment ────────────────────────────────────────
const SOURCES_SQL = `COALESCE(
  (SELECT json_agg(json_build_object(
     'id', c.id, 'topic', c.topic, 'question', c.question,
     'start_time', c.start_time, 'end_time', c.end_time
   ))
   FROM lecture_qna_chunks c
   WHERE c.id = ANY(ch.source_chunk_ids)
  ), '[]'::json
) AS sources_detail`;

// ── SESSION CRUD ───────────────────────────────────────────────

export interface ChatSession {
  id:            number;
  title:         string;
  messageCount:  number;
  firstQuestion: string | null;
  createdAt:     string;
  updatedAt:     string;
}

export const createChatSession = async (
  studentId: string,
  lectureId: number
): Promise<ChatSession> => {
  const { rows } = await query<{ id: number; title: string; created_at: Date; updated_at: Date }>(
    `INSERT INTO chat_sessions (student_id, lecture_id, title)
     VALUES ($1, $2, 'New Chat')
     RETURNING id, title, created_at, updated_at`,
    [studentId, lectureId]
  );
  const r = rows[0];
  logger.info(`[CHAT] 🆕 Created session #${r.id} for student ${studentId} lecture ${lectureId}`);
  return { id: r.id, title: r.title, messageCount: 0, firstQuestion: null, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
};

export const getChatSessions = async (
  studentId: string,
  lectureId: number
): Promise<ChatSession[]> => {
  const { rows } = await query<{
    id: number; title: string; created_at: Date; updated_at: Date;
    message_count: string; first_question: string | null;
  }>(
    `SELECT cs.id, cs.title, cs.created_at, cs.updated_at,
       COUNT(ch.id)::text  AS message_count,
       (SELECT ch2.question
        FROM chat_history ch2
        WHERE ch2.session_id = cs.id AND ch2.cleared_by_student = FALSE
        ORDER BY ch2.created_at ASC LIMIT 1) AS first_question
     FROM chat_sessions cs
     LEFT JOIN chat_history ch ON ch.session_id = cs.id AND ch.cleared_by_student = FALSE
     WHERE cs.student_id = $1 AND cs.lecture_id = $2
     GROUP BY cs.id
     ORDER BY cs.updated_at DESC`,
    [studentId, lectureId]
  );
  return rows.map(r => ({
    id:            r.id,
    title:         r.title,
    messageCount:  parseInt(r.message_count ?? '0', 10),
    firstQuestion: r.first_question ?? null,
    createdAt:     r.created_at.toISOString(),
    updatedAt:     r.updated_at.toISOString(),
  }));
};

export const getSessionHistory = async (
  studentId: string,
  sessionId: number
): Promise<ChatHistoryEntry[]> => {
  const { rows } = await query<ChatHistoryEntry>(
    `SELECT ch.*, ${SOURCES_SQL}
     FROM chat_history ch
     WHERE ch.session_id = $1 AND ch.student_id = $2 AND ch.cleared_by_student = FALSE
     ORDER BY ch.created_at ASC`,
    [sessionId, studentId]
  );
  return rows;
};

export const deleteChatSession = async (
  studentId: string,
  sessionId: number
): Promise<boolean> => {
  await query(
    `UPDATE chat_history SET cleared_by_student = TRUE
     WHERE session_id = $1 AND student_id = $2`,
    [sessionId, studentId]
  );
  const { rowCount } = await query(
    `DELETE FROM chat_sessions WHERE id = $1 AND student_id = $2`,
    [sessionId, studentId]
  );
  logger.info(`[CHAT] 🗑️  Deleted session #${sessionId} for student ${studentId}`);
  return (rowCount ?? 0) > 0;
};

export const renameChatSession = async (
  studentId: string,
  sessionId: number,
  title: string
): Promise<boolean> => {
  const { rowCount } = await query(
    `UPDATE chat_sessions SET title = $3 WHERE id = $1 AND student_id = $2`,
    [sessionId, studentId, title]
  );
  logger.info(`[CHAT] ✏️  Renamed session #${sessionId} to "${title.slice(0, 40)}"`);
  return (rowCount ?? 0) > 0;
};

// Touch session updated_at and auto-title from first question
const touchSession = async (
  studentId: string,
  sessionId: number,
  question: string
): Promise<void> => {
  await query(
    `UPDATE chat_sessions
     SET updated_at = NOW(),
         title = CASE WHEN title = 'New Chat' THEN $3 ELSE title END
     WHERE id = $2 AND student_id = $1`,
    [studentId, sessionId, question.slice(0, 80)]
  );
};

// ── SAVE CHAT ENTRY ────────────────────────────────────────────
export const saveChatEntry = async (params: {
  studentId:      string;
  lectureId:      number;
  question:       string;
  answer:         string;
  sourceChunkIds: number[];
  sessionId:      number;
}): Promise<number> => {
  const { studentId, lectureId, question, answer, sourceChunkIds, sessionId } = params;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [studentId, lectureId, question, answer, sourceChunkIds, sessionId]
  );
  logger.info(`[CHAT] ✅ Saved chat entry #${rows[0].id} for session #${sessionId}`);
  return rows[0].id;
};

// ── ASK LECTURE AGENT (orchestrator) ──────────────────────────
export const askLectureAgent = async (params: {
  studentId: string;
  lectureId: number;
  question:  string;
  sessionId: number;
}): Promise<{ answer: string; sources: QnaChunk[] }> => {
  const { studentId, lectureId, question, sessionId } = params;

  // 1. Confirm lecture is READY
  const lecture = await getLectureById(lectureId);
  if (lecture.status !== 'READY') {
    logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} not READY (status=${lecture.status})`);
    throw new AppError('AI tutor is not ready for this lecture yet. Please wait for processing.', 400);
  }

  // 2. Persist question for admin analytics before AI call
  await query(
    'INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)',
    [studentId, lectureId, question]
  );

  // 3. Lazy imports
  const { generateEmbedding }   = await import('./embedding.service');
  const { searchChunks }        = await import('./vector-search.service');
  const { rerankChunks }        = await import('./rerank.service');
  const { generateAnswer }      = await import('./llm-gemini.service');

  // 4. Load current session's history for follow-up context
  const recentHistory = await getSessionHistory(studentId, sessionId);
  const historyTurns  = recentHistory
    .slice(-10)
    .map(e => ({ question: e.question, answer: e.answer }));

  if (historyTurns.length > 0) {
    logger.info(`[CHAT] 📚 Passing ${historyTurns.length} prior turn(s) as context`);
  }

  // 5. Embed question
  logger.info(`[CHAT] 🔍 Embedding: "${question.slice(0, 60)}..."`);
  const questionEmbedding = await generateEmbedding(question, true);

  // 6. Vector search — lecture-scoped, wider candidate pool for reranking
  const candidates = await searchChunks(questionEmbedding, lectureId, 15);
  if (candidates.length === 0) {
    logger.warn(`[CHAT] ⚠️  No relevant chunks found — returning not-found message`);
    const notFound = 'I could not find this information in this lecture.';
    await saveChatEntry({ studentId, lectureId, question, answer: notFound, sourceChunkIds: [], sessionId });
    await touchSession(studentId, sessionId, question);
    return { answer: notFound, sources: [] };
  }

  logger.info(`[CHAT] ✅ ${candidates.length} candidates (top similarity=${candidates[0].similarity?.toFixed(3)})`);

  // 6b. Rerank — cross-encoder reorders by precise query-chunk relevance
  const chunks = await rerankChunks(question, candidates, 5);
  logger.info(`[CHAT] ✅ Reranked to ${chunks.length} chunks for generation`);

  // 7. Generate answer using all retrieved chunks for maximum context
  const answer = await generateAnswer(question, chunks, lecture.title, historyTurns);

  // 8. Save and touch session
  const chunkIds = chunks.map((c: QnaChunk) => c.id);
  await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: chunkIds, sessionId });
  await touchSession(studentId, sessionId, question);

  logger.info(`[CHAT] ✅ Answer saved for session #${sessionId}`);
  return { answer, sources: chunks };
};

// ── LEGACY HELPERS (kept for ChatDrawer / admin analytics) ────
export const getChatHistory = async (
  studentId: string,
  lectureId: number
): Promise<ChatHistoryEntry[]> => {
  const { rows } = await query<ChatHistoryEntry>(
    `SELECT ch.*, ${SOURCES_SQL}
     FROM chat_history ch
     WHERE ch.student_id = $1 AND ch.lecture_id = $2 AND ch.cleared_by_student = FALSE
     ORDER BY ch.created_at ASC`,
    [studentId, lectureId]
  );
  return rows;
};

export const clearChat = async (studentId: string, lectureId: number): Promise<void> => {
  await query(
    `UPDATE chat_history SET cleared_by_student = TRUE
     WHERE student_id = $1 AND lecture_id = $2 AND cleared_by_student = FALSE`,
    [studentId, lectureId]
  );
};

export const deleteChatEntry = async (studentId: string, entryId: number): Promise<boolean> => {
  const { rowCount } = await query(
    `UPDATE chat_history SET cleared_by_student = TRUE
     WHERE id = $1 AND student_id = $2 AND cleared_by_student = FALSE`,
    [entryId, studentId]
  );
  return (rowCount ?? 0) > 0;
};

export const renameChatEntry = async (studentId: string, entryId: number, label: string): Promise<boolean> => {
  const { rowCount } = await query(
    `UPDATE chat_history SET display_label = $3
     WHERE id = $1 AND student_id = $2 AND cleared_by_student = FALSE`,
    [entryId, studentId, label]
  );
  return (rowCount ?? 0) > 0;
};

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
       ORDER BY ch.created_at DESC LIMIT $3 OFFSET $4`,
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
  const trimmed = searchQuery.trim();
  if (!trimmed) return [];
  const words  = trimmed.split(/\s+/).filter(Boolean);
  const params: (string | number)[] = [studentId, lectureId];
  const wordClauses = words.map(word => {
    const escaped = word.replace(/[.*+?[\]{}()|^$\\]/g, '\\$&');
    const pattern  = `\\m${escaped}\\M`;
    const idx      = params.length + 1;
    params.push(pattern);
    return `(ch.question ~* $${idx} OR ch.answer ~* $${idx} OR COALESCE(ch.display_label,'') ~* $${idx})`;
  });
  const { rows } = await query<ChatHistoryEntry>(
    `SELECT ch.*, ${SOURCES_SQL}
     FROM chat_history ch
     WHERE ch.student_id = $1 AND ch.lecture_id = $2 AND ch.cleared_by_student = FALSE
       AND (${wordClauses.join(' AND ')})
     ORDER BY ch.created_at DESC LIMIT 50`,
    params
  );
  return rows;
};
