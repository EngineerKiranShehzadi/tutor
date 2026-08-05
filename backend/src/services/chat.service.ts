import { query } from '../config/database';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { ChatHistoryEntry, QnaChunk } from '../types';
import { getLectureById } from './lecture.service';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { RERANKER_MODEL_VERSION } from './rerank.service';
import { ANSWER_PROMPT_VERSION } from './llm-gemini.service';
import { RequestTrace, recordTrace } from '../observability/tracer';
import type { FinishedTrace, NotFoundReason, SafeMetadata } from '../observability/types';
import type { ConversationTurn } from './llm-gemini.service';
import type { DedupeResult } from './rerank.service';
import type { RetrievalQueryResult } from './query-rewriter.service';
import type { RouteClassification } from './query-router.service';
import type { SummarizeDeps } from './lecture-summary.service';
import type { MemoryLookupResult, WriteMemoryParams, LookupParams as MemoryLookupParams } from './rag-answer-memory.service';

// Exact-match fallback used by both "not found" paths below (zero vector
// candidates, and candidates that all fail the reranker relevance floor) so
// they can never drift apart.
export const LECTURE_NOT_FOUND_MESSAGE = 'I could not find this information in this lecture.';

// Injectable seam for tests only — production calls always fall through to
// the real, lazily-imported services below (defaults are only evaluated
// when a caller doesn't override them, so normal request handling still
// lazy-loads exactly as before).
export interface AskLectureAgentDeps {
  generateEmbedding?:      (text: string, isQuery?: boolean) => Promise<number[]>;
  searchChunks?:           (embedding: number[], lectureId: number, limit: number) => Promise<QnaChunk[]>;
  rerankChunks?:           (question: string, candidates: QnaChunk[], topN?: number) => Promise<QnaChunk[]>;
  dedupeAndSelect?:        (rankedChunks: QnaChunk[], desiredCount?: number, minRerankScore?: number) => DedupeResult;
  reorderForContext?:      (chunks: QnaChunk[]) => QnaChunk[];
  generateAnswer?:         (question: string, chunks: QnaChunk[], lectureTitle: string, history?: ConversationTurn[]) => Promise<string>;
  resolveRetrievalQuery?:  (question: string, history: ConversationTurn[]) => Promise<RetrievalQueryResult>;
  classifyRoute?:          (question: string) => Promise<RouteClassification>;
  getAllLectureChunks?:    (lectureId: number) => Promise<QnaChunk[]>;
  generateLectureSummary?: (chunks: QnaChunk[], lectureTitle: string, deps?: SummarizeDeps) => Promise<string | null>;
  lookupAnswerMemory?:     (params: MemoryLookupParams) => Promise<MemoryLookupResult>;
  writeAnswerMemory?:      (params: WriteMemoryParams) => Promise<void>;
  recordMemoryHit?:        (memoryId: number) => Promise<void>;
  // Test-only observability hook — called synchronously with the finished
  // trace right when the request completes. Production always falls
  // through to recordTrace (log + optional Phoenix export, fire-and-forget).
  onTraceComplete?:        (trace: FinishedTrace) => void | Promise<void>;
}

function mapRoutingMethod(source: RouteClassification['source']): 'DETERMINISTIC_RULE' | 'LLM_CLASSIFIER' | 'SAFE_DEFAULT' {
  if (source === 'rule') return 'DETERMINISTIC_RULE';
  if (source === 'llm') return 'LLM_CLASSIFIER';
  return 'SAFE_DEFAULT';
}

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
export const askLectureAgent = async (
  params: {
    studentId: string;
    lectureId: number;
    question:  string;
    sessionId: number;
  },
  deps: AskLectureAgentDeps = {}
): Promise<{ answer: string; sources: QnaChunk[] }> => {
  const { studentId, lectureId, question, sessionId } = params;

  const trace = new RequestTrace('ask-lecture-agent');
  const onTraceComplete = deps.onTraceComplete ?? recordTrace;
  trace.setAttributes({
    requestId: trace.traceId,
    lectureId,
    sessionId,
    embeddingModelVersion: EMBEDDING_MODEL_VERSION,
    rerankerModelVersion: RERANKER_MODEL_VERSION,
    answerPromptVersion: ANSWER_PROMPT_VERSION,
    semanticMemoryEnabled: env.RAG_MEMORY.SEMANTIC_ENABLED,
  });
  // Tracks which stage is in flight so an unexpected thrown error can be
  // mapped to a safe not-found/failure reason code in the outer catch.
  let currentStage = 'unknown';

  const finishTrace = (status: 'SUCCESS' | 'ERROR', extra: SafeMetadata): void => {
    const finished = trace.end(status, extra);
    // try/catch AND .catch(): onTraceComplete may throw synchronously
    // (before ever returning a promise) or reject asynchronously — either
    // way, observability must never propagate into the caller.
    try {
      void Promise.resolve(onTraceComplete(finished)).catch(err =>
        logger.warn(`[OBSERVABILITY] onTraceComplete failed (non-fatal): ${(err as Error).message}`)
      );
    } catch (err) {
      logger.warn(`[OBSERVABILITY] onTraceComplete threw synchronously (non-fatal): ${(err as Error).message}`);
    }
  };

  try {
    // 1. Confirm lecture is READY
    const lecture = await getLectureById(lectureId);
    if (lecture.status !== 'READY') {
      logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} not READY (status=${lecture.status})`);
      finishTrace('ERROR', { responseStatus: 'LECTURE_NOT_READY' });
      throw new AppError('AI tutor is not ready for this lecture yet. Please wait for processing.', 400);
    }

    // 2. Persist question for admin analytics before AI call
    await query(
      'INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)',
      [studentId, lectureId, question]
    );

    // 3. Lazy imports — skipped for any dependency the caller already
    // injected (tests only; production always falls through to these).
    const generateEmbedding     = deps.generateEmbedding     ?? (await import('./embedding.service')).generateEmbedding;
    const searchChunks          = deps.searchChunks          ?? (await import('./vector-search.service')).searchChunks;
    const rerankChunksFn        = deps.rerankChunks          ?? (await import('./rerank.service')).rerankChunks;
    const dedupeAndSelect       = deps.dedupeAndSelect       ?? (await import('./rerank.service')).dedupeAndSelect;
    const reorderForContext     = deps.reorderForContext     ?? (await import('./rerank.service')).reorderForContext;
    const generateAnswer        = deps.generateAnswer        ?? (await import('./llm-gemini.service')).generateAnswer;
    const resolveRetrievalQuery = deps.resolveRetrievalQuery ?? (await import('./query-rewriter.service')).resolveRetrievalQuery;
    const classifyRoute         = deps.classifyRoute         ?? (await import('./query-router.service')).classifyRoute;

    // 4. Load current session's history for follow-up context
    currentStage = 'load-session-history';
    const recentHistory = await trace.span('load-session-history', () => getSessionHistory(studentId, sessionId));
    const historyTurns  = recentHistory
      .slice(-10)
      .map(e => ({ question: e.question, answer: e.answer }));

    if (historyTurns.length > 0) {
      logger.info(`[CHAT] 📚 Passing ${historyTurns.length} prior turn(s) as context`);
    }

    // 4b. Route the message before doing any retrieval work — different
    // request shapes use different processing paths instead of every
    // message going through the same vector-search pipeline.
    currentStage = 'classify-query-route';
    const { route, source: routeSource } = await trace.span(
      'classify-query-route',
      () => classifyRoute(question),
      r => ({ route: r.route, routingMethod: mapRoutingMethod(r.source), routeFallbackUsed: r.source === 'llm-fallback' })
    );
    logger.info(`[CHAT] 🧭 Route=${route} (source=${routeSource})`);
    trace.setAttributes({ route, routeSelectionMethod: mapRoutingMethod(routeSource), routeFallbackUsed: routeSource === 'llm-fallback' });

    // ── GREETING — no embedding, vector search, reranking, or lecture load.
    if (route === 'GREETING') {
      const answer = `Hi! I'm the AI tutor for "${lecture.title}". Ask me anything about this lecture and I'll help explain it.`;
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: [], sessionId });
        await touchSession(studentId, sessionId, question);
      }, () => ({ sourceChunkCount: 0 }));
      logger.info(`[CHAT] ✅ Greeting answered for session #${sessionId}`);
      finishTrace('SUCCESS', { responseStatus: 'GREETING_ANSWERED', memoryResult: 'NOT_ATTEMPTED' });
      return { answer, sources: [] };
    }

    // ── LECTURE_SUMMARY — whole-lecture / hierarchical summarization. Bypasses
    // top-k vector search entirely: a summary must represent the whole
    // lecture, not just the chunks most similar to the word "summary".
    if (route === 'LECTURE_SUMMARY') {
      const summaryModule = await import('./lecture-summary.service');
      const getAllLectureChunksFn    = deps.getAllLectureChunks    ?? summaryModule.getAllLectureChunks;
      const generateLectureSummaryFn = deps.generateLectureSummary ?? summaryModule.generateLectureSummary;
      const summaryUnavailable       = summaryModule.LECTURE_SUMMARY_UNAVAILABLE_MESSAGE;

      currentStage = 'fetch-all-lecture-chunks';
      const allChunks = await trace.span(
        'fetch-all-lecture-chunks',
        () => getAllLectureChunksFn(lectureId),
        c => ({ chunkCount: c.length })
      );

      currentStage = 'summarize-lecture-content';
      const summary = allChunks.length > 0
        ? await trace.span(
            'summarize-lecture-content', // covers batching + per-batch summarize + combine as one stage
            () => generateLectureSummaryFn(allChunks, lecture.title),
            s => ({ summaryProduced: !!s })
          )
        : null;

      if (!summary) {
        const reason: NotFoundReason = allChunks.length === 0 ? 'EMPTY_LECTURE' : 'SUMMARY_CONTENT_EMPTY';
        logger.warn(`[CHAT] ⚠️  No summary available for lecture #${lectureId} (${allChunks.length} chunk(s) found)`);
        await trace.span('save-chat-entry', async () => {
          await saveChatEntry({ studentId, lectureId, question, answer: summaryUnavailable, sourceChunkIds: [], sessionId });
          await touchSession(studentId, sessionId, question);
        }, () => ({ sourceChunkCount: 0 }));
        finishTrace('SUCCESS', { responseStatus: 'NOT_FOUND', notFoundReason: reason, memoryResult: 'NOT_ATTEMPTED' });
        return { answer: summaryUnavailable, sources: [] };
      }

      const chunkIds = allChunks.map(c => c.id);
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer: summary, sourceChunkIds: chunkIds, sessionId });
        await touchSession(studentId, sessionId, question);
      }, () => ({ sourceChunkCount: chunkIds.length }));
      logger.info(`[CHAT] ✅ Summary answered for session #${sessionId} (${allChunks.length} chunk(s))`);
      finishTrace('SUCCESS', { responseStatus: 'SUMMARY_ANSWERED', selectedChunkCount: chunkIds.length, memoryResult: 'NOT_ATTEMPTED' });
      return { answer: summary, sources: allChunks };
    }

    // ── CONTEXTUAL_FOLLOW_UP / FACT_QUESTION — shared fact-retrieval pipeline.
    // Only follow-ups pay for the rewrite step; plain fact questions embed
    // the original question directly.
    let retrievalQuery = question;
    if (route === 'CONTEXTUAL_FOLLOW_UP') {
      currentStage = 'rewrite-contextual-query';
      const rewritten = await trace.span(
        'rewrite-contextual-query',
        () => resolveRetrievalQuery(question, historyTurns),
        r => ({
          rewriteAttempted: r.attempted,
          rewriteSucceeded: r.wasRewritten,
          rewriteFallbackUsed: r.attempted && !r.wasRewritten,
          historyTurnsProvided: historyTurns.length,
          ...(env.OBSERVABILITY.CAPTURE_CONTENT && env.NODE_ENV !== 'production'
            ? { rewrittenQueryPreview: r.query.slice(0, 40) }
            : {}),
        }),
        r => (r.attempted && !r.wasRewritten ? 'FALLBACK' : 'SUCCESS')
      );
      retrievalQuery = rewritten.query;
      if (rewritten.wasRewritten) {
        logger.info(`[CHAT] ✏️  Using rewritten retrieval query: "${retrievalQuery.slice(0, 80)}"`);
      }
      trace.setAttributes({ rewriteAttempted: rewritten.attempted, rewriteSucceeded: rewritten.wasRewritten, rewriteFallbackUsed: rewritten.attempted && !rewritten.wasRewritten });
    }

    // 4c. Answer-memory lookup — FACT_QUESTION only (a contextual follow-up
    // can still depend on wording only present in the current conversation,
    // even after rewriting, so it's excluded from reuse in this phase). A
    // hit skips embedding/search/rerank/generation entirely; a miss still
    // reuses the embedding this generates below, so retrieval never embeds
    // the same text twice.
    let precomputedEmbedding: number[] | null = null;
    let memoryLectureContentHash: string | null = null;
    let memoryResultAttr = 'NOT_ATTEMPTED';

    if (route === 'FACT_QUESTION') {
      currentStage = 'exact-memory-lookup';
      const lookupAnswerMemory = deps.lookupAnswerMemory ?? (await import('./rag-answer-memory.service')).lookupAnswerMemory;
      const memoryResult = await trace.span(
        'exact-memory-lookup', // also covers the optional semantic sub-lookup when enabled
        () => lookupAnswerMemory({ studentId, lectureId, question, generateEmbedding }),
        r => ({
          memoryResult: r.lookupFailed ? 'LOOKUP_FAILED' : r.hit ? (r.hit.matchType === 'EXACT' ? 'EXACT_HIT' : 'SEMANTIC_HIT') : 'MISS',
          semanticAttempted: env.RAG_MEMORY.SEMANTIC_ENABLED,
        })
      );
      memoryLectureContentHash = memoryResult.lectureContentHash;
      memoryResultAttr = memoryResult.lookupFailed ? 'LOOKUP_FAILED' : memoryResult.hit ? (memoryResult.hit.matchType === 'EXACT' ? 'EXACT_HIT' : 'SEMANTIC_HIT') : 'MISS';

      if (memoryResult.hit) {
        const recordMemoryHit = deps.recordMemoryHit ?? (await import('./rag-answer-memory.service')).recordMemoryHit;
        await recordMemoryHit(memoryResult.hit.memoryId);
        await trace.span('save-chat-entry', async () => {
          await saveChatEntry({
            studentId, lectureId, question,
            answer: memoryResult.hit!.answer,
            sourceChunkIds: memoryResult.hit!.sourceChunkIds,
            sessionId,
          });
          await touchSession(studentId, sessionId, question);
        }, () => ({ sourceChunkCount: memoryResult.hit!.sourceChunkIds.length }));
        logger.info(`[CHAT] ✅ Answer-memory ${memoryResult.hit.matchType} hit served for session #${sessionId}`);
        finishTrace('SUCCESS', {
          responseStatus: 'MEMORY_HIT_ANSWERED',
          memoryResult: memoryResultAttr,
          selectedChunkCount: memoryResult.hit.sourceChunkIds.length,
        });
        return { answer: memoryResult.hit.answer, sources: memoryResult.hit.chunks };
      }

      precomputedEmbedding = memoryResult.embedding;
    }

    // 5. Embed the retrieval query (reuse the embedding computed during
    // answer-memory lookup, if any, instead of generating it twice)
    let questionEmbedding: number[];
    if (precomputedEmbedding) {
      questionEmbedding = precomputedEmbedding;
    } else {
      logger.info(`[CHAT] 🔍 Embedding: "${retrievalQuery.slice(0, 60)}..."`);
      currentStage = 'generate-query-embedding';
      questionEmbedding = await trace.span(
        'generate-query-embedding',
        () => generateEmbedding(retrievalQuery, true),
        vec => ({ embeddingModelVersion: EMBEDDING_MODEL_VERSION, inputCharLength: retrievalQuery.length, vectorDimension: vec.length, retryCount: 0 })
      );
    }

    // 6. Vector search — lecture-scoped, wider candidate pool for reranking
    currentStage = 'vector-search';
    const CANDIDATE_LIMIT = 15;
    const candidates = await trace.span(
      'vector-search',
      () => searchChunks(questionEmbedding, lectureId, CANDIDATE_LIMIT),
      c => ({
        lectureId,
        candidateLimit: CANDIDATE_LIMIT,
        candidateCount: c.length,
        topCosineSimilarity: c[0]?.similarity ?? null,
        lowestReturnedSimilarity: c[c.length - 1]?.similarity ?? null,
        zeroCandidateResult: c.length === 0,
      })
    );
    if (candidates.length === 0) {
      logger.warn(`[CHAT] ⚠️  No relevant chunks found — returning not-found message`);
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer: LECTURE_NOT_FOUND_MESSAGE, sourceChunkIds: [], sessionId });
        await touchSession(studentId, sessionId, question);
      }, () => ({ sourceChunkCount: 0 }));
      finishTrace('SUCCESS', { responseStatus: 'NOT_FOUND', notFoundReason: 'NO_VECTOR_CANDIDATES', memoryResult: memoryResultAttr, candidateCount: 0 });
      return { answer: LECTURE_NOT_FOUND_MESSAGE, sources: [] };
    }

    logger.info(`[CHAT] ✅ ${candidates.length} candidates (top similarity=${candidates[0].similarity?.toFixed(3)})`);

    // 6b. Rerank — cross-encoder scores the full candidate pool by precise
    // query-chunk relevance (not just the top 5, so dedup below has real
    // backfill material from what's already been computed). Dedup and
    // relevance-floor exclusion are covered by the same span: both are
    // about how many of the reranked candidates survive to generation.
    currentStage = 'rerank-candidates';
    let dedupedAwayCount = 0;
    let belowFloorCount = 0;
    let topRerankerScore: number | null = null;
    const chunks = await trace.span(
      'rerank-candidates',
      async () => {
        const rankedAll = await rerankChunksFn(retrievalQuery, candidates, candidates.length);
        topRerankerScore = rankedAll[0]?.rerankScore ?? null;
        const { selected, dedupedAway } = dedupeAndSelect(rankedAll, 5);
        dedupedAwayCount = dedupedAway.length;
        belowFloorCount = Math.max(0, rankedAll.length - selected.length - dedupedAway.length);
        return selected;
      },
      c => ({
        rerankerModelVersion: RERANKER_MODEL_VERSION,
        rerankerInputCount: candidates.length,
        rerankerOutputCount: c.length,
        topRerankerScore,
        lowestSelectedRerankerScore: c[c.length - 1]?.rerankScore ?? null,
        chunksRemovedByRelevanceFloor: belowFloorCount,
        chunksRemovedByDedupe: dedupedAwayCount,
      })
    );
    if (dedupedAwayCount > 0) {
      logger.info(`[CHAT] 🧹 Deduped ${dedupedAwayCount} duplicate-answer chunk(s) → ${chunks.length} distinct chunks for generation`);
    } else {
      logger.info(`[CHAT] ✅ ${chunks.length} distinct chunks for generation (no duplicates)`);
    }

    // 6d. Everything survived retrieval but the relevance floor removed every
    // candidate — same not-found outcome as zero candidates, without ever
    // calling Gemini with an empty context.
    if (chunks.length === 0) {
      logger.warn(`[CHAT] ⚠️  All candidates fell below the relevance floor — returning not-found message`);
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer: LECTURE_NOT_FOUND_MESSAGE, sourceChunkIds: [], sessionId });
        await touchSession(studentId, sessionId, question);
      }, () => ({ sourceChunkCount: 0 }));
      finishTrace('SUCCESS', {
        responseStatus: 'NOT_FOUND',
        notFoundReason: 'ALL_CANDIDATES_BELOW_RERANK_FLOOR',
        memoryResult: memoryResultAttr,
        candidateCount: candidates.length,
        selectedChunkCount: 0,
      });
      return { answer: LECTURE_NOT_FOUND_MESSAGE, sources: [] };
    }

    // 7. Generate answer — reorder for the "lost in the middle" effect: best
    // and 2nd-best chunk at the edges of the prompt, worst chunk buried in
    // the middle. chunkIds/sources below intentionally keep rerank order.
    const contextChunks = reorderForContext(chunks);
    currentStage = 'generate-grounded-answer';
    const answer = await trace.span(
      'generate-grounded-answer',
      () => generateAnswer(question, contextChunks, lecture.title, historyTurns),
      () => ({ answerPromptVersion: ANSWER_PROMPT_VERSION, contextChunkCount: contextChunks.length })
    );

    // 8. Save and touch session
    const chunkIds = chunks.map((c: QnaChunk) => c.id);
    currentStage = 'save-chat-entry';
    const savedEntryId = await trace.span('save-chat-entry', async () => {
      const id = await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: chunkIds, sessionId });
      await touchSession(studentId, sessionId, question);
      return id;
    }, () => ({ sourceChunkCount: chunkIds.length }));

    // 9. Answer-memory write — FACT_QUESTION only, after a successful,
    // grounded, chunk-backed answer is already saved. Best-effort: any
    // failure here must never change the response already returned below.
    if (route === 'FACT_QUESTION') {
      try {
        const memoryService = await import('./rag-answer-memory.service');
        const writeAnswerMemory = deps.writeAnswerMemory ?? memoryService.writeAnswerMemory;
        const lectureContentHash = memoryLectureContentHash ?? await memoryService.computeLectureContentHash(lectureId);
        await writeAnswerMemory({
          studentId,
          lectureId,
          sourceChatHistoryId: savedEntryId,
          originalQuestion: question,
          retrievalQuery,
          answer,
          sourceChunkIds: chunkIds,
          questionEmbedding,
          lectureContentHash,
        });
        if (memoryResultAttr === 'MISS') memoryResultAttr = 'ENTRY_CREATED';
      } catch (err) {
        logger.warn(`[CHAT] ⚠️  Answer-memory write skipped: ${(err as Error).message}`);
        if (memoryResultAttr === 'MISS') memoryResultAttr = 'WRITE_FAILED';
      }
    }

    logger.info(`[CHAT] ✅ Answer saved for session #${sessionId}`);
    finishTrace('SUCCESS', {
      responseStatus: 'ANSWERED',
      memoryResult: memoryResultAttr,
      candidateCount: candidates.length,
      selectedChunkCount: chunks.length,
    });
    return { answer, sources: chunks };
  } catch (err) {
    if (err instanceof AppError) throw err; // already recorded above (lecture-not-ready path)
    const notFoundReason: NotFoundReason | undefined =
      currentStage === 'generate-query-embedding' ? 'EMBEDDING_FAILURE'
      : currentStage === 'vector-search' ? 'VECTOR_SEARCH_FAILURE'
      : currentStage === 'rerank-candidates' ? 'RERANKER_FAILURE'
      : undefined;
    finishTrace('ERROR', { responseStatus: 'ERROR', failedStage: currentStage, ...(notFoundReason ? { notFoundReason } : {}) });
    throw err;
  }
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
