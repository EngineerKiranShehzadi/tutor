import { query } from '../config/database';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { ChatHistoryEntry, QnaChunk, LectureAgentProfile } from '../types';
import { getLectureById } from './lecture.service';
import { getLectureReadiness, LectureReadiness } from './dataset-version.service';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { RERANKER_MODEL_VERSION, DEFAULT_MIN_RERANK_SCORE } from './rerank.service';
import { SIMILARITY_THRESHOLD } from './vector-search.service';
import { ANSWER_PROMPT_VERSION } from './llm-gemini.service';
import { RequestTrace, recordTrace } from '../observability/tracer';
import { ATTR } from '../observability/otel-semconv';
import { isContentCaptureEnabled, truncateContent, logSafeText } from '../observability/sanitize';
import type { FinishedTrace, NotFoundReason, SafeMetadata } from '../observability/types';
import { OBSERVABILITY_SCHEMA_VERSION } from '../observability/types';
import { runInputGuardrails, REJECTION_MESSAGE_BY_REASON } from '../rag/guardrails/input/input-guardrail.service';
import type { InputGuardrailResult } from '../rag/guardrails/input/input-guardrail.service';
import { decomposeQuery } from '../rag/query-processing/decomposition/subquery-decomposition.service';
import type { SubqueryDecompositionResult } from '../rag/query-processing/decomposition/subquery-decomposition.types';
import { retrieveForDecomposedQuery, classifyEmptyDecomposedResult, decomposedContextBudget, splitUncoveredAspects } from '../rag/query-processing/retrieval/decomposed-retrieval.service';
import { runAdaptiveRetrieval } from '../rag/query-processing/adaptive-retrieval/adaptive-retrieval.service';
import type { AdaptiveRetrievalParams } from '../rag/query-processing/adaptive-retrieval/adaptive-retrieval.service';
import type { AdaptiveRetrievalResult } from '../rag/query-processing/adaptive-retrieval/adaptive-retrieval.types';
import type { SubqueryRetrievalDeps } from '../rag/query-processing/retrieval/decomposed-retrieval.service';
import { runOutputGuardrail, VERIFICATION_UNAVAILABLE_MESSAGE } from '../rag/guardrails/output/output-guardrail.service';
import { createPiiSafeStream } from '../rag/guardrails/output/pii/streaming-pii-redactor';
import type { OutputGuardrailParams } from '../rag/guardrails/output/output-guardrail.service';
import type { OutputGuardrailResult } from '../rag/guardrails/output/answer-verification.types';
import type { ConversationTurn, AnswerStreamHandlers } from './llm-gemini.service';
import type { DedupeResult } from './rerank.service';
import type { RetrievalQueryResult } from './query-rewriter.service';
import type { RouteClassification } from './query-router.service';
import type { SummarizeDeps } from './lecture-summary.service';
import type { MemoryLookupResult, WriteMemoryParams, LookupParams as MemoryLookupParams } from './rag-answer-memory.service';
import type { AgentProfileLookup } from './lecture-agent-profile.service';

// Exact-match fallback used by both "not found" paths below (zero vector
// candidates, and candidates that all fail the reranker relevance floor) so
// they can never drift apart.
export const LECTURE_NOT_FOUND_MESSAGE = 'I could not find this information in this lecture.';

// Injectable seam for tests only — production calls always fall through to
// the real, lazily-imported services below (defaults are only evaluated
// when a caller doesn't override them, so normal request handling still
// lazy-loads exactly as before).
// "MISSING_EMBEDDINGS: 2/5 chunk(s) of active version 7 ..." -> "MISSING_EMBEDDINGS 2/5".
// Keeps the code plus the n/total counts, drops the free-text and version ids.
export function compactReadinessReason(reason: string): string {
  const code = reason.split(':')[0].trim();
  const counts = /(\d+)\/(\d+)/.exec(reason);
  return counts ? `${code} ${counts[1]}/${counts[2]}` : code;
}

// The last `turns` prior exchanges (history is oldest-first), as the
// question/answer pairs the router, rewriter and answer prompt consume.
// slice(-0) would return everything, so 0 is handled explicitly.
export function selectHistoryTurns(
  history: ChatHistoryEntry[],
  turns: number
): { question: string; answer: string }[] {
  if (turns <= 0) return [];
  return history.slice(-turns).map(e => ({ question: e.question, answer: e.answer }));
}

export interface AskLectureAgentDeps {
  runInputGuardrails?:     (question: string) => Promise<InputGuardrailResult>;
  generateEmbedding?:      (text: string, isQuery?: boolean) => Promise<number[]>;
  searchChunks?:           (embedding: number[], lectureId: number, limit: number, datasetVersionId?: number) => Promise<QnaChunk[]>;
  rerankChunks?:           (question: string, candidates: QnaChunk[], topN?: number) => Promise<QnaChunk[]>;
  dedupeAndSelect?:        (rankedChunks: QnaChunk[], desiredCount?: number, minRerankScore?: number) => DedupeResult;
  reorderForContext?:      (chunks: QnaChunk[]) => QnaChunk[];
  generateAnswer?:         (question: string, chunks: QnaChunk[], lectureTitle: string, history?: ConversationTurn[], uncoveredAspects?: string[], attempt?: number, stream?: AnswerStreamHandlers, agentProfile?: LectureAgentProfile | null, unavailableAspects?: string[]) => Promise<string>;
  // Resolves the lecture's agent profile by lecture_id only (see
  // lecture-agent-profile.service.ts). Defaults to the real service.
  getAgentProfile?:        (lectureId: number) => Promise<AgentProfileLookup>;
  // Dataset readiness (active version fully embedded). Defaults to the real service.
  getLectureReadiness?:    (lectureId: number) => Promise<LectureReadiness>;
  resolveRetrievalQuery?:  (question: string, history: ConversationTurn[]) => Promise<RetrievalQueryResult>;
  classifyRoute?:          (question: string) => Promise<RouteClassification>;
  generateGreeting?:       (message: string, lectureTitle: string, history?: ConversationTurn[]) => Promise<string>;
  decomposeQuery?:         (effectiveQuery: string) => Promise<SubqueryDecompositionResult>;
  runAdaptiveRetrieval?:   (params: AdaptiveRetrievalParams, deps: SubqueryRetrievalDeps) => Promise<AdaptiveRetrievalResult>;
  runOutputGuardrail?:     (params: OutputGuardrailParams) => Promise<OutputGuardrailResult>;
  getAllLectureChunks?:    (lectureId: number, datasetVersionId?: number) => Promise<QnaChunk[]>;
  // Test-only: pin the request to this dataset version instead of resolving the active one.
  datasetVersionId?:       number | null;
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
  traceId?:       string;
}): Promise<number> => {
  const { studentId, lectureId, question, answer, sourceChunkIds, sessionId, traceId } = params;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids, session_id, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [studentId, lectureId, question, answer, sourceChunkIds, sessionId, traceId ?? null]
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
    // Optional live streaming of the grounded-answer draft (SSE endpoint).
    // Only the main generation step streams; greetings, summaries, memory
    // hits and guardrail fallbacks return their text via the final result.
    // The returned answer stays authoritative — the output guardrail may
    // revise or replace the streamed draft, so consumers must reconcile.
    stream?: AnswerStreamHandlers;
  },
  deps: AskLectureAgentDeps = {}
): Promise<{ answer: string; sources: QnaChunk[] }> => {
  const { studentId, lectureId, sessionId } = params;
  // Reassigned once the input guardrail runs — from that point on, every
  // downstream stage (routing, persistence, logs, every LLM prompt) sees the
  // guarded (possibly PII-sanitized) text. The one exception is the direct
  // path's embed/search/rerank text — see unmaskedQuestion below.
  let question = params.question;

  const trace = new RequestTrace('ask-lecture-agent');
  const onTraceComplete = deps.onTraceComplete ?? recordTrace;
  trace.setAttributes({
    requestId: trace.traceId,
    lectureId,
    sessionId,
    studentId,
    // Declares which version of the custom-attribute contract this trace's
    // exporter guarantees (see OBSERVABILITY_SCHEMA_VERSION's doc comment).
    // Traces recorded before this attribute existed carry no such marker —
    // overview aggregation treats that absence as unknown coverage, never
    // as proof of any particular guarantee. Do not derive schema
    // compatibility from deploy/export time alone; this explicit marker is
    // the only authoritative signal.
    observabilitySchemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    embeddingModelVersion: EMBEDDING_MODEL_VERSION,
    rerankerModelVersion: RERANKER_MODEL_VERSION,
    answerPromptVersion: ANSWER_PROMPT_VERSION,
    semanticMemoryEnabled: env.RAG_MEMORY.SEMANTIC_ENABLED,
    environment: env.NODE_ENV,
    // Deliberately NOT captured here — the raw question may still contain
    // PII the input guardrail hasn't sanitized yet. The (possibly
    // sanitized) INPUT_VALUE is set once the guardrail stage completes,
    // below.
  });
  // Tracks which stage is in flight so an unexpected thrown error can be
  // mapped to a safe not-found/failure reason code in the outer catch.
  let currentStage = 'unknown';
  // Set when a stage reports a retrieval failure itself instead of throwing
  // from a DIRECT-path stage (see the decomposed zero-result branch). Wins
  // over the currentStage mapping in the outer catch.
  let retrievalFailureReason: NotFoundReason | undefined;

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

  // Registers `trace` as "the active trace" for this entire call chain
  // (including every nested service function called below, no matter how
  // many modules deep) — see RequestTrace.runAsActive()/getActiveTrace() in
  // tracer.ts. This is what lets withLlmDiagnostic() (llm/llm-observability.
  // service.ts) attach real nested LLM spans (gemini_router_call,
  // gemini_answer_call, prompt_injection_classifier_call, ...) under
  // whichever trace.span() is currently executing, without threading
  // `trace` through every function signature in the pipeline.
  return trace.runAsActive(() => runAskLectureAgent());

  async function runAskLectureAgent(): Promise<{ answer: string; sources: QnaChunk[] }> {
  try {
    // 1. Confirm lecture is READY
    const lecture = await getLectureById(lectureId);
    if (lecture.status !== 'READY') {
      logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} not READY (status=${lecture.status})`);
      finishTrace('ERROR', { responseStatus: 'LECTURE_NOT_READY' });
      throw new AppError('AI tutor is not ready for this lecture yet. Please wait for processing.', 400);
    }

    // 1-bis. Dataset readiness: an active version whose every chunk is embedded
    // with the current model. A lecture that is READY by status but fails this
    // would only ever answer "not found", so reject it as not ready instead.
    const readiness = await (deps.getLectureReadiness ?? getLectureReadiness)(lectureId);
    if (!readiness.ready) {
      logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} dataset not ready: ${readiness.reason}`);
      finishTrace('ERROR', { responseStatus: 'LECTURE_NOT_READY', notFoundReason: compactReadinessReason(readiness.reason) });
      throw new AppError('AI tutor is not ready for this lecture yet. Please wait for processing.', 400);
    }

    // 1a. Lecture agent profile — deterministic, selected by the validated
    // lectureId only (never by title, lecture number, or an LLM). Runs right
    // after the READY check and before the input guardrail so a lecture with
    // a missing or disabled agent is rejected before ANY other chat path
    // (greeting, summary, memory, retrieval, generation) can execute, and
    // before anything is written. There is deliberately no fallback to a
    // generic tutor: NOT_FOUND and INACTIVE are explicit errors, and a
    // database failure propagates (it is never reported as NOT_FOUND).
    currentStage = 'load-agent-profile';
    const getAgentProfile = deps.getAgentProfile ?? (await import('./lecture-agent-profile.service')).getAgentProfileByLectureId;
    const agentLookup = await getAgentProfile(lectureId);
    if (agentLookup.status !== 'FOUND') {
      logger.warn(`[CHAT] ⚠️  Lecture #${lectureId} has no usable agent profile (status=${agentLookup.status})`);
      finishTrace('ERROR', { responseStatus: 'ERROR', failedStage: currentStage });
      throw new AppError(
        agentLookup.status === 'INACTIVE'
          ? 'The AI tutor for this lecture is currently unavailable. Please try again later or contact your course administrator.'
          : 'The AI tutor for this lecture has not been configured yet. Please contact your course administrator.',
        503
      );
    }
    const agentProfile: LectureAgentProfile = agentLookup.profile;
    if (agentProfile.lecture_id !== lectureId) {
      // Defence in depth: a profile for another lecture must never be used.
      throw new Error(`[AGENT-PROFILE] profile for lecture #${agentProfile.lecture_id} returned for lecture #${lectureId}`);
    }
    // Computed exactly once; the SAME value is passed to the answer-memory
    // exact lookup, its semantic lookup, and the memory write below, so an
    // agent-generated answer is never stored or matched under the generic
    // version (see getEffectiveAnswerPromptVersion).
    const answerPromptVersion = (await import('./rag-answer-memory.service')).getEffectiveAnswerPromptVersion(agentProfile);

    // 1a-2. Chat session validation — the supplied sessionId must exist, belong
    // to THIS student, and have been created for THIS lecture. Runs before
    // the input guardrail (which may call an LLM) and before anything reads
    // history or writes a row, so a mismatched session can never pull
    // another lecture's conversation into this lecture's agent prompt, and a
    // student can never write into someone else's session. One generic
    // not-found error covers all three failure modes, so the response does
    // not reveal whether a session id exists or who owns it. A database
    // failure here propagates (it is never treated as a valid session).
    currentStage = 'validate-chat-session';
    const { rows: sessionRows } = await query<{ ok: number }>(
      `SELECT 1 AS ok FROM chat_sessions WHERE id = $1 AND student_id = $2 AND lecture_id = $3`,
      [sessionId, studentId, lectureId]
    );
    if (sessionRows.length === 0) {
      logger.warn(`[CHAT] ⚠️  Rejected session #${sessionId}: not found for student/lecture #${lectureId}`);
      finishTrace('ERROR', { responseStatus: 'ERROR', failedStage: currentStage });
      throw new AppError('Chat session not found for this lecture. Please refresh the page and try again.', 404);
    }

    // 1b. Input Guardrail — runs before query-router.service.ts (see
    // rag/guardrails/input/input-guardrail.service.ts). ALLOW/SANITIZE
    // continue with the (possibly sanitized) text as `question` for every
    // stage below, including persistence; REJECT stops the request here,
    // before anything is written to the database or sent to any LLM.
    currentStage = 'input-guardrail';
    const runGuardrails = deps.runInputGuardrails ?? runInputGuardrails;
    const guardrailResult = await trace.span(
      'input-guardrail',
      () => runGuardrails(question),
      r => ({
        'guardrail.action': r.action,
        'guardrail.reason': r.reason ?? null,
        'guardrail.pii_detected': Boolean(r.metadata?.piiDetected),
        // Category labels only (e.g. "EMAIL,PHONE") — never the detected
        // values themselves. Comma-joined to fit SafeMetadata's flat
        // string|number|boolean shape, same convention as candidateIds/
        // selectedChunkIds elsewhere in this file.
        'guardrail.pii_categories': Array.isArray(r.metadata?.piiCategories) ? r.metadata.piiCategories.join(',') : null,
        'guardrail.injection_detection_method': (r.metadata?.injectionDetectionMethod as string | undefined) ?? null,
        'guardrail.injection_decision': (r.metadata?.injectionDecision as string | undefined) ?? null,
        'guardrail.llm_fallback_used': Boolean(r.metadata?.llmFallbackUsed),
      }),
      r => (r.action === 'REJECT' ? 'ERROR' : r.action === 'SANITIZE' ? 'FALLBACK' : 'SUCCESS')
    );
    trace.setAttributes({
      guardrailAction: guardrailResult.action,
      guardrailReason: guardrailResult.reason ?? null,
    });

    if (guardrailResult.action === 'REJECT') {
      logger.warn(`[CHAT] 🛡️  Input guardrail rejected question (reason=${guardrailResult.reason})`);
      finishTrace('SUCCESS', {
        responseStatus: 'GUARDRAIL_REJECTED',
        memoryResult: 'NOT_ATTEMPTED',
        guardrailReason: guardrailResult.reason,
      });
      const message = (guardrailResult.reason && REJECTION_MESSAGE_BY_REASON[guardrailResult.reason])
        || 'Your message could not be processed. Please rephrase your question.';
      throw new AppError(message, 400);
    }

    // Carry the guarded (possibly PII-sanitized) text forward — every stage
    // from here on, including the DB write immediately below, sees this
    // value instead of the raw original (except searchQuery, below).
    question = guardrailResult.sanitizedInput ?? question;
    // The same text before PII masking. Used ONLY as the text that is
    // embedded, vector-searched and reranked on the direct path — a masked
    // "[PHONE]" would search for the placeholder, not the number. Never
    // stored, logged, traced or sent to an LLM; those all use `question`.
    const unmaskedQuestion = guardrailResult.retrievalInput ?? question;
    trace.setAttributes({
      ...(isContentCaptureEnabled() ? { [ATTR.INPUT_VALUE]: truncateContent(question, 500).value } : {}),
    });

    // 2. Persist question for admin analytics before AI call
    await query(
      'INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)',
      [studentId, lectureId, question]
    );

    // 3. Lazy imports — skipped for any dependency the caller already
    // injected (tests only; production always falls through to these).
    const generateEmbedding     = deps.generateEmbedding     ?? (await import('./embedding.service')).generateEmbedding;
    // Pin this request to ONE dataset version: every retrieval call below (the
    // direct search, each decomposed sub-query, adaptive retrieval, the summary
    // route) and the answer-memory lookup/write use the same version, so a
    // dataset published while the request is running cannot mix two versions.
    const pinnedVersionId = deps.datasetVersionId !== undefined
      ? deps.datasetVersionId
      : await (await import('./rag-answer-memory.service')).getActiveDatasetVersionId(lectureId);
    const searchChunksBase      = deps.searchChunks          ?? (await import('./vector-search.service')).searchChunks;
    const searchChunks          = (embedding: number[], lecId: number, limit: number) =>
      searchChunksBase(embedding, lecId, limit, pinnedVersionId ?? undefined);
    const rerankChunksFn        = deps.rerankChunks          ?? (await import('./rerank.service')).rerankChunks;
    const dedupeAndSelect       = deps.dedupeAndSelect       ?? (await import('./rerank.service')).dedupeAndSelect;
    const reorderForContext     = deps.reorderForContext     ?? (await import('./rerank.service')).reorderForContext;
    const generateAnswer        = deps.generateAnswer        ?? (await import('./llm-gemini.service')).generateAnswer;
    const resolveRetrievalQuery = deps.resolveRetrievalQuery ?? (await import('./query-rewriter.service')).resolveRetrievalQuery;
    const classifyRoute         = deps.classifyRoute         ?? (await import('./query-router.service')).classifyRoute;
    const generateGreeting      = deps.generateGreeting      ?? (await import('./greeting-response.service')).generateGreetingResponse;

    // 4. Load current session's history for follow-up context
    currentStage = 'load-session-history';
    const recentHistory = await trace.span('load-session-history', () => getSessionHistory(studentId, sessionId));
    const historyTurns  = selectHistoryTurns(recentHistory, env.CHAT.HISTORY_TURNS);

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
      currentStage = 'generate-greeting-response';
      const answer = await trace.span(
        'generate-greeting-response',
        () => generateGreeting(question, lecture.title, historyTurns),
        a => ({ answerLength: a.length })
      );
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: [], sessionId, traceId: trace.traceId });
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
      const getAllLectureChunksBase  = deps.getAllLectureChunks    ?? summaryModule.getAllLectureChunks;
      const getAllLectureChunksFn    = (lecId: number) => getAllLectureChunksBase(lecId, pinnedVersionId ?? undefined);
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
          await saveChatEntry({ studentId, lectureId, question, answer: summaryUnavailable, sourceChunkIds: [], sessionId, traceId: trace.traceId });
          await touchSession(studentId, sessionId, question);
        }, () => ({ sourceChunkCount: 0 }));
        finishTrace('SUCCESS', { responseStatus: 'NOT_FOUND', notFoundReason: reason, memoryResult: 'NOT_ATTEMPTED' });
        return { answer: summaryUnavailable, sources: [] };
      }

      const chunkIds = allChunks.map(c => c.id);
      await trace.span('save-chat-entry', async () => {
        await saveChatEntry({ studentId, lectureId, question, answer: summary, sourceChunkIds: chunkIds, sessionId, traceId: trace.traceId });
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
        logger.info(`[CHAT] ✏️  Using rewritten retrieval query: "${logSafeText(retrievalQuery, 80)}"`);
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
    let memoryDatasetVersionId: number | null = null;
    let memoryResultAttr = 'NOT_ATTEMPTED';

    if (route === 'FACT_QUESTION') {
      currentStage = 'exact-memory-lookup';
      const lookupAnswerMemory = deps.lookupAnswerMemory ?? (await import('./rag-answer-memory.service')).lookupAnswerMemory;
      const memoryResult = await trace.span(
        'exact-memory-lookup', // also covers the optional semantic sub-lookup when enabled
        () => lookupAnswerMemory({ studentId, lectureId, question, generateEmbedding, answerPromptVersion, datasetVersionId: pinnedVersionId }),
        r => ({
          memoryResult: r.lookupFailed ? 'LOOKUP_FAILED' : r.hit ? (r.hit.matchType === 'EXACT' ? 'EXACT_HIT' : 'SEMANTIC_HIT') : 'MISS',
          semanticAttempted: env.RAG_MEMORY.SEMANTIC_ENABLED,
          matchType: r.hit?.matchType ?? null,
          matchedMemoryId: r.hit?.memoryId ?? null,
          similarity: r.hit?.similarity ?? null,
        })
      );
      memoryDatasetVersionId = memoryResult.datasetVersionId;
      memoryResultAttr = memoryResult.lookupFailed ? 'LOOKUP_FAILED' : memoryResult.hit ? (memoryResult.hit.matchType === 'EXACT' ? 'EXACT_HIT' : 'SEMANTIC_HIT') : 'MISS';

      if (memoryResult.hit) {
        const recordMemoryHit = deps.recordMemoryHit ?? (await import('./rag-answer-memory.service')).recordMemoryHit;
        await trace.span(
          'record-memory-hit',
          () => recordMemoryHit(memoryResult.hit!.memoryId),
          () => ({ memoryId: memoryResult.hit!.memoryId })
        );
        await trace.span('save-chat-entry', async () => {
          await saveChatEntry({
            studentId, lectureId, question,
            answer: memoryResult.hit!.answer,
            sourceChunkIds: memoryResult.hit!.sourceChunkIds,
            sessionId,
            traceId: trace.traceId,
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

    // 4d. Selective Subquery Decomposition — operates on the effective
    // self-contained query (retrievalQuery: the rewritten query for
    // CONTEXTUAL_FOLLOW_UP, or the original question for FACT_QUESTION).
    // A cheap deterministic gate decides whether this is even a candidate
    // before any LLM call happens — see rag/query-processing/decomposition/
    // compound-query.detector.ts — so an ordinary question pays zero extra
    // latency. Distinct from and runs after the history rewriter above;
    // never merged into it.
    currentStage = 'decompose-query';
    const decomposeQueryFn = deps.decomposeQuery ?? decomposeQuery;
    const decomposition = await trace.span(
      'decompose-query',
      () => decomposeQueryFn(retrievalQuery),
      (d: SubqueryDecompositionResult) => ({
        'query.decomposition.enabled': env.QUERY_DECOMPOSITION.ENABLED,
        'query.decomposition.mode': d.mode,
        'query.decomposition.reason': d.reason,
        'query.decomposition.llm_used': d.llmUsed,
        'query.decomposition.subquery_count': d.subqueries.length,
      }),
      (d: SubqueryDecompositionResult) =>
        (['CLASSIFIER_TIMEOUT', 'CLASSIFIER_ERROR', 'INVALID_SUBQUERY_LIST'].includes(d.reason) ? 'FALLBACK' : 'SUCCESS')
    );
    trace.setAttributes({ decompositionMode: decomposition.mode, decompositionReason: decomposition.reason });
    if (decomposition.mode === 'DECOMPOSED') {
      logger.info(`[CHAT] 🔀 Decomposed into ${decomposition.subqueries.length} subquery(ies): ${decomposition.subqueries.map(s => `"${logSafeText(s, 50)}"`).join(', ')}`);
    }

    // 5/6. Retrieval — DIRECT reuses the existing single-query embed ->
    // vector-search -> rerank -> dedupe pipeline completely unchanged.
    // DECOMPOSED fans the same building blocks out across every subquery
    // concurrently and merges with coverage-aware selection — see rag/
    // query-processing/retrieval/decomposed-retrieval.service.ts. Both
    // converge on `chunks` (rerank/citation order) before generation.
    let chunks: QnaChunk[];
    let finalCandidateCount: number;
    let uncoveredAspects: string[] = [];
    // Decomposed parts whose lookup failed (outage) — kept out of
    // uncoveredAspects so they are never called "not in this lecture".
    let unavailableAspects: string[] = [];
    // Only ever populated by the DIRECT branch below — a decomposed query
    // has no single embedding representing the parent query (each subquery
    // gets its own, see decomposed-retrieval.service.ts). Answer-memory
    // still needs one for the parent/effective question; it's computed
    // on-demand at the write-memory step below when this stays null.
    let questionEmbedding: number[] | null = null;
    // What the DIRECT path embeds and reranks: the unmasked question when
    // retrieval is using the student's own wording, else the rewrite (which
    // was produced from the masked text). Decomposed subqueries come from an
    // LLM call, so they are built from the masked text.
    const searchQuery = retrievalQuery === question ? unmaskedQuestion : retrievalQuery;

    if (decomposition.mode === 'DECOMPOSED') {
      currentStage = 'decomposed-retrieval';
      // A compound question gets a wider context budget than a single one,
      // scaled by its subquery count — see decomposedContextBudget.
      const contextBudget = decomposedContextBudget(decomposition.subqueries.length);
      trace.setAttributes({ 'query.decomposition.context_budget': contextBudget });
      const decomposedResult = await retrieveForDecomposedQuery(
        { lectureId, subqueries: decomposition.subqueries, desiredCount: contextBudget },
        { generateEmbedding, searchChunks, rerankChunks: rerankChunksFn }
      );
      finalCandidateCount = decomposedResult.totalCandidateCount;
      ({ notFound: uncoveredAspects, unavailable: unavailableAspects } =
        splitUncoveredAspects(decomposition.subqueries, decomposedResult.uncoveredSubqueryIndexes, decomposedResult.perSubquery));
      trace.setAttributes({
        'query.decomposition.covered_subqueries': decomposedResult.coveredSubqueryIndexes.join(','),
        'query.decomposition.uncovered_subqueries': decomposedResult.uncoveredSubqueryIndexes.join(','),
        'query.decomposition.unavailable_subqueries': decomposedResult.perSubquery.filter(r => r.failureReason === 'RETRIEVAL_ERROR').map(r => r.index).join(','),
      });

      // Only a complete absence of evidence across every subquery is a real
      // "not found" — partial coverage continues to generation below, which
      // is told (via uncoveredAspects) which part(s) it must not guess at.
      // Zero chunks because a lookup failed (embed/search/rerank outage) is
      // an error, exactly as on the DIRECT path — never "not in this lecture".
      if (decomposedResult.selectedChunks.length === 0) {
        const empty = classifyEmptyDecomposedResult(decomposedResult.perSubquery);
        if (empty.outcome === 'ERROR') {
          retrievalFailureReason = empty.reason;
          throw new Error(`Decomposed retrieval failed (${empty.reason}); no subquery produced evidence`);
        }
        logger.warn(`[CHAT] ⚠️  No subquery produced qualifying evidence — returning not-found message`);
        await trace.span('save-chat-entry', async () => {
          await saveChatEntry({ studentId, lectureId, question, answer: LECTURE_NOT_FOUND_MESSAGE, sourceChunkIds: [], sessionId, traceId: trace.traceId });
          await touchSession(studentId, sessionId, question);
        }, () => ({ sourceChunkCount: 0 }));
        finishTrace('SUCCESS', {
          responseStatus: 'NOT_FOUND',
          notFoundReason: empty.reason,
          memoryResult: memoryResultAttr,
          candidateCount: finalCandidateCount,
          selectedChunkCount: 0,
        });
        return { answer: LECTURE_NOT_FOUND_MESSAGE, sources: [] };
      }

      chunks = decomposedResult.selectedChunks;
      logger.info(`[CHAT] ✅ Decomposed retrieval: ${decomposedResult.coveredSubqueryIndexes.length}/${decomposition.subqueries.length} subquery(ies) covered → ${chunks.length} chunks for generation`);

      // 6c. Iterative Adaptive Retrieval — only runs when decomposition's
      // own deterministic coverage signal already found a real gap (never
      // for a fully-covered decomposed query, never for a DIRECT query).
      // Makes at most ADAPTIVE_RETRIEVAL_MAX_ITERATIONS bounded, targeted
      // retrieval attempts for the specific uncovered aspect(s) — see
      // rag/query-processing/adaptive-retrieval/adaptive-retrieval.
      // service.ts for the full stop-condition list. Never re-runs
      // decomposition itself and never broadens beyond what it already
      // identified as missing.
      if (decomposedResult.uncoveredSubqueryIndexes.length > 0) {
        currentStage = 'adaptive-retrieval';
        const runAdaptive = deps.runAdaptiveRetrieval ?? runAdaptiveRetrieval;
        const adaptiveResult = await runAdaptive(
          {
            effectiveQuery: retrievalQuery,
            lectureId,
            subqueries: decomposition.subqueries,
            perSubquery: decomposedResult.perSubquery,
            coveredSubqueryIndexes: decomposedResult.coveredSubqueryIndexes,
            uncoveredSubqueryIndexes: decomposedResult.uncoveredSubqueryIndexes,
            desiredCount: contextBudget,
          },
          { generateEmbedding, searchChunks, rerankChunks: rerankChunksFn }
        );
        trace.setAttributes({
          adaptiveRetrievalTriggered: adaptiveResult.triggered,
          adaptiveRetrievalStopReason: adaptiveResult.stopReason,
        });
        if (adaptiveResult.triggered) {
          chunks = adaptiveResult.selectedChunks;
          // A part adaptive retrieval recovered becomes covered; one that
          // is still uncovered keeps the reason its first lookup had.
          ({ notFound: uncoveredAspects, unavailable: unavailableAspects } =
            splitUncoveredAspects(decomposition.subqueries, adaptiveResult.uncoveredSubqueryIndexes, decomposedResult.perSubquery));
          finalCandidateCount += adaptiveResult.iterations.reduce((sum, it) => sum + it.newChunkCount, 0);
          if (adaptiveResult.coveredSubqueryIndexes.length > decomposedResult.coveredSubqueryIndexes.length) {
            logger.info(`[CHAT] 🔁 Adaptive retrieval recovered evidence for ${adaptiveResult.coveredSubqueryIndexes.length - decomposedResult.coveredSubqueryIndexes.length} subquery(ies) (${adaptiveResult.iterations.length} iteration(s), stopReason=${adaptiveResult.stopReason})`);
          } else {
            logger.info(`[CHAT] 🔁 Adaptive retrieval made no further progress (stopReason=${adaptiveResult.stopReason})`);
          }
        }
      }
    } else {
      // 5. Embed the retrieval query (reuse the embedding computed during
      // answer-memory lookup, if any, instead of generating it twice)
      // The memory lookup embedded the masked question; reuse it only when
      // that is also what we search with (i.e. nothing was masked).
      if (precomputedEmbedding && searchQuery === retrievalQuery) {
        questionEmbedding = precomputedEmbedding;
      } else {
        logger.info(`[CHAT] 🔍 Embedding: "${logSafeText(retrievalQuery, 60)}"`);
        currentStage = 'generate-query-embedding';
        questionEmbedding = await trace.span(
          'generate-query-embedding',
          () => generateEmbedding(searchQuery, true),
          vec => ({ embeddingModelVersion: EMBEDDING_MODEL_VERSION, inputCharLength: searchQuery.length, vectorDimension: vec.length, retryCount: 0 })
        );
      }

      // 6. Vector search — lecture-scoped, wider candidate pool for reranking
      currentStage = 'vector-search';
      const CANDIDATE_LIMIT = 15;
      // Just assigned above in both branches — a non-null local so the
      // closure below (which TS can't narrow a captured outer `let`
      // through) has a definitely-number[] value to call searchChunks with.
      const embeddingForSearch: number[] = questionEmbedding!;
      const candidates = await trace.span(
        'vector-search',
        () => searchChunks(embeddingForSearch, lectureId, CANDIDATE_LIMIT),
        c => ({
          [ATTR.RETRIEVAL_DOCUMENTS]: JSON.stringify(c.map((chunk, i) => ({ id: chunk.id, score: chunk.similarity ?? null, rank: i }))),
          lectureId,
          candidateLimit: CANDIDATE_LIMIT,
          candidateCount: c.length,
          similarityThreshold: SIMILARITY_THRESHOLD,
          topCosineSimilarity: c[0]?.similarity ?? null,
          lowestReturnedSimilarity: c[c.length - 1]?.similarity ?? null,
          zeroCandidateResult: c.length === 0,
          candidateIds: c.map(chunk => chunk.id).join(','),
        })
      );
      finalCandidateCount = candidates.length;
      if (candidates.length === 0) {
        logger.warn(`[CHAT] ⚠️  No relevant chunks found — returning not-found message`);
        await trace.span('save-chat-entry', async () => {
          await saveChatEntry({ studentId, lectureId, question, answer: LECTURE_NOT_FOUND_MESSAGE, sourceChunkIds: [], sessionId, traceId: trace.traceId });
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
      chunks = await trace.span(
        'rerank-candidates',
        async () => {
          const rankedAll = await rerankChunksFn(searchQuery, candidates, candidates.length);
          topRerankerScore = rankedAll[0]?.rerankScore ?? null;
          const { selected, dedupedAway } = dedupeAndSelect(rankedAll, 5);
          dedupedAwayCount = dedupedAway.length;
          belowFloorCount = Math.max(0, rankedAll.length - selected.length - dedupedAway.length);
          return selected;
        },
        c => ({
          [ATTR.RERANKER_MODEL_NAME]: RERANKER_MODEL_VERSION,
          [ATTR.RERANKER_OUTPUT_DOCUMENTS]: JSON.stringify(c.map((chunk, i) => ({ id: chunk.id, score: chunk.rerankScore ?? null, rank: i }))),
          rerankerModelVersion: RERANKER_MODEL_VERSION,
          rerankerInputCount: candidates.length,
          rerankerOutputCount: c.length,
          minRerankScore: DEFAULT_MIN_RERANK_SCORE,
          topRerankerScore,
          lowestSelectedRerankerScore: c[c.length - 1]?.rerankScore ?? null,
          chunksRemovedByRelevanceFloor: belowFloorCount,
          chunksRemovedByDedupe: dedupedAwayCount,
          selectedChunkIds: c.map(chunk => chunk.id).join(','),
          ...(isContentCaptureEnabled() ? { [ATTR.RERANKER_QUERY]: truncateContent(retrievalQuery, 300).value } : {}),
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
          await saveChatEntry({ studentId, lectureId, question, answer: LECTURE_NOT_FOUND_MESSAGE, sourceChunkIds: [], sessionId, traceId: trace.traceId });
          await touchSession(studentId, sessionId, question);
        }, () => ({ sourceChunkCount: 0 }));
        finishTrace('SUCCESS', {
          responseStatus: 'NOT_FOUND',
          notFoundReason: 'ALL_CANDIDATES_BELOW_RERANK_FLOOR',
          memoryResult: memoryResultAttr,
          candidateCount: finalCandidateCount,
          selectedChunkCount: 0,
        });
        return { answer: LECTURE_NOT_FOUND_MESSAGE, sources: [] };
      }
    }

    // 7. Generate answer — reorder for the "lost in the middle" effect: best
    // and 2nd-best chunk at the edges of the prompt, worst chunk buried in
    // the middle. chunkIds/sources below intentionally keep rerank order.
    const contextChunks = reorderForContext(chunks);
    currentStage = 'generate-grounded-answer';
    // The streamed draft is PII-redacted piece by piece before it is sent
    // (text already on screen can't be taken back). Groundedness/format are
    // still settled by the final answer, which replaces the draft.
    const piiSafeStream = params.stream && env.OUTPUT_PII_GUARD.ENABLED ? createPiiSafeStream(params.stream) : undefined;
    const draftStream = piiSafeStream ?? params.stream;
    const draftAnswer = await trace.span(
      'generate-grounded-answer',
      // uncoveredAspects is only ever non-empty for a decomposed query with
      // partial coverage — see generateAnswer's doc comment in
      // llm-gemini.service.ts for how it's used (a note, never merged into
      // the grounded context itself).
      async () => {
        const draft = await generateAnswer(question, contextChunks, lecture.title, historyTurns, uncoveredAspects, 1, draftStream, agentProfile, unavailableAspects);
        piiSafeStream?.flush();
        return draft;
      },
      a => ({
        answerPromptVersion: ANSWER_PROMPT_VERSION,
        contextChunkCount: contextChunks.length,
        contextChunkIds: contextChunks.map(c => c.id).join(','),
        answerCharLength: a.length,
        uncoveredAspectCount: uncoveredAspects.length,
        unavailableAspectCount: unavailableAspects.length,
        ...(isContentCaptureEnabled() ? { [ATTR.OUTPUT_VALUE]: truncateContent(a, 2000).value } : {}),
      })
    );

    // 7b. Output Guardrail — post-generation groundedness verification (see
    // rag/guardrails/output/output-guardrail.service.ts). Judges the draft
    // against the exact contextChunks actually supplied to the generator,
    // never a fresh retrieval pass — Iterative Adaptive Retrieval already
    // owns pre-generation evidence gaps. Verify -> optional bounded revise
    // -> re-verify -> the result below is what actually gets persisted;
    // an unsupported draft never reaches chat_history/answer memory.
    currentStage = 'output-guardrail';
    const runGuardrail = deps.runOutputGuardrail ?? runOutputGuardrail;
    const guardrailOutcome = await runGuardrail({
      question,
      // Selective Output Format Validation reads its LIST/TABLE signals
      // from the same effective, self-contained query already used for
      // retrieval — see OutputGuardrailParams.effectiveQuery's doc comment.
      effectiveQuery: retrievalQuery,
      uncoveredAspects,
      unavailableAspects,
      evidenceTexts: contextChunks.map(c => c.chunk_text),
      draftAnswer,
      notFoundMessage: LECTURE_NOT_FOUND_MESSAGE,
    });
    trace.setAttributes({
      answerVerificationEnabled: env.ANSWER_VERIFICATION.ENABLED,
      answerVerificationDecision: guardrailOutcome.decision,
      answerVerificationReason: guardrailOutcome.reason,
      answerVerificationVerified: guardrailOutcome.verified,
      outputFormatExpected: guardrailOutcome.expectedFormat,
      outputFormatValid: guardrailOutcome.formatValid,
      outputFormatRepairAttempted: guardrailOutcome.formatRepairAttempted,
      outputFormatRepairSucceeded: guardrailOutcome.formatRepairSucceeded,
      outputPiiDetected: guardrailOutcome.piiDetected,
      outputPiiCategories: guardrailOutcome.piiCategories.join(','),
    });
    if (guardrailOutcome.reason !== 'VERIFIED') {
      logger.info(`[CHAT] 🛡️  Output guardrail: ${guardrailOutcome.reason} (verified=${guardrailOutcome.verified}, revisionAttempted=${guardrailOutcome.revisionAttempted})`);
    }
    // The verifier could not run. Failing closed means the draft is not
    // served, but this is an outage, not "the lecture doesn't cover it": it
    // is traced as an ERROR and nothing is saved to chat history or answer
    // memory, so a transient failure never becomes a permanent turn.
    if (guardrailOutcome.verificationUnavailable) {
      logger.error(`[CHAT] ❌ Answer verification unavailable (${guardrailOutcome.reason}) — returning 503, nothing saved`);
      finishTrace('ERROR', {
        responseStatus: 'ERROR',
        failedStage: 'output-guardrail',
        answerVerificationReason: guardrailOutcome.reason,
        memoryResult: memoryResultAttr,
        candidateCount: finalCandidateCount,
        selectedChunkCount: chunks.length,
      });
      throw new AppError(VERIFICATION_UNAVAILABLE_MESSAGE, 503);
    }
    if (guardrailOutcome.piiDetected) {
      logger.info(`[CHAT] 🛡️  Output guardrail: PII sanitized in final answer (${guardrailOutcome.piiCategories.join(', ')})`);
    }
    const answer = guardrailOutcome.finalAnswer;

    // 8. Save and touch session
    const chunkIds = chunks.map((c: QnaChunk) => c.id);
    currentStage = 'save-chat-entry';
    const savedEntryId = await trace.span('save-chat-entry', async () => {
      const id = await saveChatEntry({ studentId, lectureId, question, answer, sourceChunkIds: chunkIds, sessionId, traceId: trace.traceId });
      await touchSession(studentId, sessionId, question);
      return id;
    }, () => ({ sourceChunkCount: chunkIds.length }));

    // 9. Answer-memory write — FACT_QUESTION only, after a successful,
    // grounded, chunk-backed answer is already saved, AND only once output
    // verification actually passed (guardrailOutcome.verified). A
    // conservative fallback (verification failed/timed out/never got
    // verified) must never be cached as if it were a good answer — for a
    // transient verifier failure in particular, caching that fallback
    // would keep serving "not found" for a question retrieval could
    // actually answer. Best-effort: any failure here must never change the
    // response already returned below. An answer that says a part "couldn't
    // be retrieved right now" is transient by definition, so it is never cached.
    if (route === 'FACT_QUESTION' && guardrailOutcome.verified && unavailableAspects.length === 0) {
      try {
        const memoryService = await import('./rag-answer-memory.service');
        const writeAnswerMemory = deps.writeAnswerMemory ?? memoryService.writeAnswerMemory;
        const datasetVersionId = memoryDatasetVersionId ?? await memoryService.getActiveDatasetVersionId(lectureId);
        if (datasetVersionId === null) throw new Error('lecture has no active dataset version');
        // A decomposed query never computes a single embedding for the
        // parent/effective question (each subquery gets its own — see
        // decomposed-retrieval.service.ts, and the "do not distort the
        // architecture to reuse a parent-query embedding" rule this
        // implements). Answer-memory still needs one to support the
        // optional semantic-similarity lookup, so it's computed here, once,
        // only when actually persisting — never during retrieval itself.
        // Stored with the answer, so it must be of the masked text (the same
        // text the semantic lookup embeds) — not of the unmasked search query.
        const memoryEmbedding = questionEmbedding && searchQuery === retrievalQuery
          ? questionEmbedding
          : await generateEmbedding(retrievalQuery, true);
        await trace.span(
          'write-answer-memory',
          () => writeAnswerMemory({
            studentId,
            lectureId,
            sourceChatHistoryId: savedEntryId,
            originalQuestion: question,
            retrievalQuery,
            answer,
            sourceChunkIds: chunkIds,
            questionEmbedding: memoryEmbedding,
            datasetVersionId,
            answerPromptVersion,
          }),
          () => ({ writeAttempted: true, sourceChunkCount: chunkIds.length })
        );
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
      candidateCount: finalCandidateCount,
      selectedChunkCount: chunks.length,
      answerCharLength: answer.length,
      ...(isContentCaptureEnabled() ? { [ATTR.OUTPUT_VALUE]: truncateContent(answer, 2000).value } : {}),
    });
    return { answer, sources: chunks };
  } catch (err) {
    if (err instanceof AppError) throw err; // already recorded above (lecture-not-ready path)
    const notFoundReason: NotFoundReason | undefined =
      retrievalFailureReason ? retrievalFailureReason
      : currentStage === 'generate-query-embedding' ? 'EMBEDDING_FAILURE'
      : currentStage === 'vector-search' ? 'VECTOR_SEARCH_FAILURE'
      : currentStage === 'rerank-candidates' ? 'RERANKER_FAILURE'
      : undefined;
    finishTrace('ERROR', { responseStatus: 'ERROR', failedStage: currentStage, ...(notFoundReason ? { notFoundReason } : {}) });
    throw err;
  }
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
