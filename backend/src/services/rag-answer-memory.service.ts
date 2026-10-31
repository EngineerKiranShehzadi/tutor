import { createHash } from 'crypto';
import { query } from '../config/database';
import { env } from '../config/env';
import { QnaChunk, LectureAgentProfile } from '../types';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { ANSWER_PROMPT_VERSION } from './answer-generation.service';

// ── Effective answer prompt version ─────────────────────────────────────
// The answer_prompt_version column (TEXT, part of the UNIQUE key and both
// lookup indexes) records which prompt a cached answer was generated under.
// A generic answer keeps the plain base version ("v1"). An answer generated
// with a lecture agent's instructions gets "<base>+agent:<sha256>", where the
// hash covers exactly what the agent contributes to the prompt (its name and
// its trimmed instructions — the same values buildAgentInstructionBlock in
// answer-generation.service.ts uses). Consequences, all by plain equality on the
// existing column:
//  - editing an agent's name/instructions changes the version, so previous
//    cache rows simply stop matching (no deletion, no manual bump);
//  - an agent version can never equal a generic one (it always carries the
//    "+agent:" suffix), so old generic answers are never served as agent
//    answers or vice versa;
//  - bumping ANSWER_PROMPT_VERSION invalidates both kinds.
// Not part of the dataset version on purpose: the version keeps meaning
// "the lecture's content" (see getActiveDatasetVersionId).
//
// If the fixed agent prompt text itself (the precedence rule or block layout
// in answer-generation.service.ts) ever changes, bump ANSWER_PROMPT_VERSION — same
// rule as for SYSTEM_PROMPT.
const AGENT_FINGERPRINT_FORMAT = 1;

export const computeAgentConfigFingerprint = (
  profile: Pick<LectureAgentProfile, 'agent_name' | 'instructions'>
): string => {
  // JSON.stringify of an object with a fixed key order: every string value
  // is quoted and escaped, so field boundaries are unambiguous — unlike plain
  // concatenation, ("ab","c") and ("a","bc") can never produce the same input.
  const canonical = JSON.stringify({
    format: AGENT_FINGERPRINT_FORMAT,
    agent_name: profile.agent_name,
    instructions: profile.instructions.trim(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

// `baseVersion` defaults to the global ANSWER_PROMPT_VERSION; it is a
// parameter only so tests can show the effective version tracks it.
export const getEffectiveAnswerPromptVersion = (
  profile?: Pick<LectureAgentProfile, 'agent_name' | 'instructions'> | null,
  baseVersion: string = ANSWER_PROMPT_VERSION
): string => (profile ? `${baseVersion}+agent:${computeAgentConfigFingerprint(profile)}` : baseVersion);

// undefined => the global version (every pre-agent caller). A blank string is
// a caller bug and is rejected (null) rather than silently stored or replaced.
const resolvePromptVersion = (explicit: string | undefined): string | null => {
  if (explicit === undefined) return ANSWER_PROMPT_VERSION;
  return explicit.trim() === '' ? null : explicit;
};

// ── Normalization ──────────────────────────────────────────────────────
// Conservative on purpose: only case/whitespace/unicode-form and harmless
// leading/trailing sentence punctuation are collapsed. Numbers, symbols
// (e.g. "C++"), negation, and word order are all left untouched so
// different-intent questions never collapse onto the same key. Typed text
// ("what is x ?"), pasted text and speech-to-text output ("What is x?") of
// the same question must all land on one key — stripping happens AFTER
// whitespace collapse and trims again, so a space before a trailing "?"
// can't survive into the key.
const EDGE_PUNCTUATION = /^[\s?!.,;:"'()]+|[\s?!.,;:"'()]+$/g;

export const normalizeQuery = (question: string): string =>
  question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '');

// ── Dataset version binding ─────────────────────────────────────────────
// A cached answer is valid only for the dataset version it was generated from.
// Every lookup and write carries the lecture's ACTIVE dataset version id
// (dataset_versions, see migration 006/007): publishing another version — or
// rolling back to an older one — changes that id, so an answer cached under a
// different version can never be returned. No hashing of the lecture's chunks
// per request any more; the version id is a single indexed read.
export const getActiveDatasetVersionId = async (lectureId: number): Promise<number | null> => {
  const { rows } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1',
    [lectureId]
  );
  return rows[0]?.active_version_id ?? null;
};

// Fetches chunks by id, scoped to the lecture AND to the given dataset
// version, preserving the requested order. A shorter result than `chunkIds`
// means some chunks are not part of that version (or no longer exist) —
// callers use that to invalidate a memory candidate.
export const getChunksByIds = async (lectureId: number, chunkIds: number[], datasetVersionId: number): Promise<QnaChunk[]> => {
  if (chunkIds.length === 0) return [];
  const { rows } = await query<QnaChunk>(
    `SELECT c.id, c.lecture_id, c.topic, c.question, c.answer, c.chunk_text, c.start_time, c.end_time, c.keywords
     FROM lecture_qna_chunks c
     JOIN dataset_version_chunks d ON d.chunk_id = c.id AND d.version_id = $3
     WHERE c.lecture_id = $1 AND c.id = ANY($2)`,
    [lectureId, chunkIds, datasetVersionId]
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return chunkIds.map(id => byId.get(id)).filter((c): c is QnaChunk => !!c);
};

// ── Lookup ────────────────────────────────────────────────────────────

export interface MemoryHit {
  matchType: 'EXACT' | 'SEMANTIC';
  memoryId: number;
  answer: string;
  sourceChunkIds: number[];
  chunks: QnaChunk[];
  similarity?: number;
}

export interface MemoryLookupResult {
  hit: MemoryHit | null;
  // Set whenever this lookup generated a question embedding, so the caller
  // can reuse it for lecture vector search instead of embedding again.
  embedding: number[] | null;
  // The dataset version this lookup ran against, so a later memory write in
  // the same request is stored under the same version.
  datasetVersionId: number | null;
  // True only when the lookup itself failed (DB/unexpected error) and this
  // is the safe fallback result — distinct from a clean "no match found"
  // miss, for observability (LOOKUP_FAILED vs MISS).
  lookupFailed: boolean;
}

export interface LookupParams {
  // The dataset version this request is pinned to (resolved once per chat
  // request). Omitted: the lecture's active version at lookup time.
  datasetVersionId?: number | null;
  studentId: string;
  lectureId: number;
  question: string;
  generateEmbedding: (text: string, isQuery?: boolean) => Promise<number[]>;
  // Effective prompt version to match against — see
  // getEffectiveAnswerPromptVersion. Defaults to ANSWER_PROMPT_VERSION, so
  // callers that don't use agent profiles are unaffected. A caller that
  // passes one here MUST pass the same value to writeAnswerMemory.
  answerPromptVersion?: string;
}

export interface SemanticLookupOptions {
  // Both default to env.RAG_MEMORY.* — overridable per call so tests (and
  // any future per-request tuning) don't depend on process env at all.
  semanticEnabled?: boolean;
  similarityThreshold?: number | null;
}

const EXACT_LOOKUP_SQL = `
  SELECT m.id, m.answer, m.source_chunk_ids
  FROM rag_answer_memory m
  JOIN chat_history ch ON ch.id = m.source_chat_history_id
  WHERE m.student_id = $1
    AND m.lecture_id = $2
    AND m.normalized_query = $3
    AND m.dataset_version_id = $4
    AND m.embedding_model_version = $5
    AND m.answer_prompt_version = $6
    AND m.cache_eligible = TRUE
    AND ch.cleared_by_student = FALSE
  LIMIT 1
`;

const SEMANTIC_LOOKUP_SQL = `
  SELECT m.id, m.answer, m.source_chunk_ids,
         1 - (m.question_embedding <=> $6::vector) AS similarity
  FROM rag_answer_memory m
  JOIN chat_history ch ON ch.id = m.source_chat_history_id
  WHERE m.student_id = $1
    AND m.lecture_id = $2
    AND m.dataset_version_id = $3
    AND m.embedding_model_version = $4
    AND m.answer_prompt_version = $5
    AND m.cache_eligible = TRUE
    AND ch.cleared_by_student = FALSE
  ORDER BY m.question_embedding <=> $6::vector
  LIMIT 5
`;

// Entry point used by chat.service.ts, FACT_QUESTION only. Never throws —
// any failure (DB, embedding) is logged and treated as a miss so the
// caller always falls through to the normal RAG pipeline.
export const lookupAnswerMemory = async (
  params: LookupParams,
  opts: SemanticLookupOptions = {}
): Promise<MemoryLookupResult> => {
  const { studentId, lectureId, question, generateEmbedding } = params;
  const semanticEnabled = opts.semanticEnabled ?? env.RAG_MEMORY.SEMANTIC_ENABLED;
  const threshold = opts.similarityThreshold !== undefined ? opts.similarityThreshold : env.RAG_MEMORY.SIMILARITY_THRESHOLD;
  const failed: MemoryLookupResult = { hit: null, embedding: null, datasetVersionId: null, lookupFailed: true };

  const promptVersion = resolvePromptVersion(params.answerPromptVersion);
  if (promptVersion === null) {
    logger.warn('[RAG-MEMORY] memoryLookupFailed: blank answerPromptVersion supplied — treating as a miss');
    return failed;
  }

  try {
    const normalized = normalizeQuery(question);
    const datasetVersionId = params.datasetVersionId !== undefined ? params.datasetVersionId : await getActiveDatasetVersionId(lectureId);
    if (datasetVersionId === null) {
      // No published dataset: nothing can be cached or served for this lecture.
      logger.info('[RAG-MEMORY] memoryMiss (lecture has no active dataset version)');
      return { hit: null, embedding: await generateEmbedding(question, true), datasetVersionId: null, lookupFailed: false };
    }
    const versionParams = [studentId, lectureId, normalized, datasetVersionId, EMBEDDING_MODEL_VERSION, promptVersion];

    // 1. Exact normalized-question match.
    const { rows: exactRows } = await query<{ id: number; answer: string; source_chunk_ids: number[] }>(
      EXACT_LOOKUP_SQL,
      versionParams
    );
    if (exactRows[0]) {
      const candidate = exactRows[0];
      const chunks = await getChunksByIds(lectureId, candidate.source_chunk_ids, datasetVersionId);
      if (chunks.length === candidate.source_chunk_ids.length) {
        logger.info(`[RAG-MEMORY] memoryExactHit id=${candidate.id}`);
        return {
          hit: { matchType: 'EXACT', memoryId: candidate.id, answer: candidate.answer, sourceChunkIds: candidate.source_chunk_ids, chunks },
          embedding: null,
          datasetVersionId,
          lookupFailed: false,
        };
      }
      logger.warn(`[RAG-MEMORY] memoryInvalidSource id=${candidate.id} (${chunks.length}/${candidate.source_chunk_ids.length} source chunks are in the active dataset version)`);
    } else {
      // Observability only: was there an entry for this exact question
      // under a different content/model/prompt version?
      const { rows: staleRows } = await query<{ id: number }>(
        `SELECT id FROM rag_answer_memory
         WHERE student_id = $1 AND lecture_id = $2 AND normalized_query = $3 AND cache_eligible = TRUE
         LIMIT 1`,
        [studentId, lectureId, normalized]
      );
      if (staleRows[0]) {
        logger.info(`[RAG-MEMORY] memoryStale id=${staleRows[0].id} (dataset version, embedding model, or prompt version changed since cached)`);
      }
    }

    // 2. No exact hit — generate the query embedding once. Reused below for
    // semantic lookup and, on a miss, by the caller for lecture retrieval.
    const embedding = await generateEmbedding(question, true);

    // 3. Optional semantic lookup, behind config, disabled by default.
    if (!semanticEnabled) {
      logger.info('[RAG-MEMORY] memoryMiss (semantic disabled)');
      return { hit: null, embedding, datasetVersionId, lookupFailed: false };
    }

    if (threshold === null || threshold === undefined || Number.isNaN(threshold)) {
      logger.warn('[RAG-MEMORY] Semantic memory enabled but RAG_MEMORY_SIMILARITY_THRESHOLD is unset/invalid — skipping semantic lookup');
      return { hit: null, embedding, datasetVersionId, lookupFailed: false };
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    const { rows: semanticRows } = await query<{ id: number; answer: string; source_chunk_ids: number[]; similarity: number }>(
      SEMANTIC_LOOKUP_SQL,
      [studentId, lectureId, datasetVersionId, EMBEDDING_MODEL_VERSION, promptVersion, vectorLiteral]
    );

    // Walk ranked candidates best-first: a stale top match (deleted source
    // chunks) shouldn't sink the whole lookup when a valid, still-eligible
    // candidate further down the (small, pre-filtered) list would do.
    for (const candidate of semanticRows) {
      if (candidate.similarity < threshold) break; // rest are equal or weaker (score-sorted)

      const chunks = await getChunksByIds(lectureId, candidate.source_chunk_ids, datasetVersionId);
      if (chunks.length !== candidate.source_chunk_ids.length) {
        logger.warn(`[RAG-MEMORY] memoryInvalidSource id=${candidate.id} (semantic candidate, ${chunks.length}/${candidate.source_chunk_ids.length} chunks still exist)`);
        continue;
      }

      logger.info(`[RAG-MEMORY] memorySemanticHit id=${candidate.id} similarity=${candidate.similarity.toFixed(3)}`);
      return {
        hit: { matchType: 'SEMANTIC', memoryId: candidate.id, answer: candidate.answer, sourceChunkIds: candidate.source_chunk_ids, chunks, similarity: candidate.similarity },
        embedding,
        datasetVersionId,
        lookupFailed: false,
      };
    }

    logger.info(`[RAG-MEMORY] memoryMiss (semantic, best=${semanticRows[0]?.similarity?.toFixed(3) ?? 'n/a'}, threshold=${threshold})`);
    return { hit: null, embedding, datasetVersionId, lookupFailed: false };
  } catch (err) {
    logger.warn(`[RAG-MEMORY] memoryLookupFailed: ${(err as Error).message}`);
    return failed;
  }
};

// Best-effort usage-metadata bump on a hit. Never throws.
export const recordMemoryHit = async (memoryId: number): Promise<void> => {
  try {
    await query(`UPDATE rag_answer_memory SET hit_count = hit_count + 1, last_used_at = NOW() WHERE id = $1`, [memoryId]);
  } catch (err) {
    logger.warn(`[RAG-MEMORY] Failed to update hit metadata for memory #${memoryId}: ${(err as Error).message}`);
  }
};

// ── Write ─────────────────────────────────────────────────────────────

export interface WriteMemoryParams {
  studentId: string;
  lectureId: number;
  sourceChatHistoryId: number;
  originalQuestion: string;
  retrievalQuery: string;
  answer: string;
  sourceChunkIds: number[];
  questionEmbedding: number[];
  // The dataset version the answer was generated from (the one the preceding
  // lookup ran against).
  datasetVersionId: number;
  // Must equal the answerPromptVersion used for the lookup that preceded
  // this write (see LookupParams.answerPromptVersion). Defaults to
  // ANSWER_PROMPT_VERSION for callers that don't use agent profiles.
  answerPromptVersion?: string;
}

// Called only after a successful, grounded FACT_QUESTION answer has already
// been saved to chat_history. Never throws — a write failure must never
// change the response already returned to the student. Upserts on the
// (student, lecture, normalized_query, dataset/model/prompt version)
// uniqueness rule instead of inserting duplicates.
export const writeAnswerMemory = async (params: WriteMemoryParams): Promise<void> => {
  const {
    studentId, lectureId, sourceChatHistoryId, originalQuestion, retrievalQuery,
    answer, sourceChunkIds, questionEmbedding, datasetVersionId,
  } = params;

  if (sourceChunkIds.length === 0) return; // matches the DB CHECK constraint; nothing to cache

  const promptVersion = resolvePromptVersion(params.answerPromptVersion);
  if (promptVersion === null) {
    logger.warn('[RAG-MEMORY] memoryWriteFailed: blank answerPromptVersion supplied — nothing stored');
    return;
  }

  try {
    const normalized = normalizeQuery(originalQuestion);
    const vectorLiteral = `[${questionEmbedding.join(',')}]`;

    // Guard against a publish landing mid-request: the answer's source chunks
    // must all belong to the version it is about to be filed under.
    const { rows: member } = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM dataset_version_chunks WHERE version_id = $1 AND chunk_id = ANY($2::int[])',
      [datasetVersionId, sourceChunkIds]
    );
    if (Number(member[0].n) !== new Set(sourceChunkIds).size) {
      logger.warn(`[RAG-MEMORY] memoryWriteSkipped: source chunks are not all in dataset version ${datasetVersionId}`);
      return;
    }

    await query(
      `INSERT INTO rag_answer_memory (
         student_id, lecture_id, source_chat_history_id,
         original_question, retrieval_query, normalized_query, question_embedding,
         answer, source_chunk_ids, route,
         dataset_version_id, embedding_model_version, answer_prompt_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,'FACT_QUESTION',$10,$11,$12)
       ON CONFLICT (student_id, lecture_id, normalized_query, dataset_version_id, embedding_model_version, answer_prompt_version)
       DO UPDATE SET
         answer                  = EXCLUDED.answer,
         source_chunk_ids        = EXCLUDED.source_chunk_ids,
         source_chat_history_id  = EXCLUDED.source_chat_history_id,
         question_embedding      = EXCLUDED.question_embedding,
         retrieval_query         = EXCLUDED.retrieval_query,
         updated_at               = NOW()`,
      [
        studentId, lectureId, sourceChatHistoryId,
        originalQuestion, retrievalQuery, normalized, vectorLiteral,
        answer, sourceChunkIds,
        datasetVersionId, EMBEDDING_MODEL_VERSION, promptVersion,
      ]
    );
    logger.info(`[RAG-MEMORY] memoryEntryCreated lecture=${lectureId} chunks=${sourceChunkIds.length}`);
  } catch (err) {
    logger.warn(`[RAG-MEMORY] memoryWriteFailed: ${(err as Error).message}`);
  }
};
