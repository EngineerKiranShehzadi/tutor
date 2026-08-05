import { query } from '../config/database';
import { env } from '../config/env';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { ANSWER_PROMPT_VERSION } from './llm-gemini.service';

// ── Normalization ──────────────────────────────────────────────────────
// Conservative on purpose: only case/whitespace/harmless-trailing-punctuation
// are collapsed. Numbers, symbols, negation, and word order are all left
// untouched so different-intent questions never collapse onto the same key.
const TRAILING_PUNCTUATION = /[?!.,;:]+$/;

export const normalizeQuery = (question: string): string =>
  question.trim().toLowerCase().replace(/\s+/g, ' ').replace(TRAILING_PUNCTUATION, '');

// ── Lecture content fingerprint ─────────────────────────────────────────
// Deterministic hash over every chunk's id + content, ordered by id — not a
// stored column on `lectures`. processDataset deletes and reinserts every
// chunk for a lecture on each dataset upload (chunk.service.ts), so any
// content replacement changes this hash automatically; nothing needs to
// remember to bump a version number by hand.
export const computeLectureContentHash = async (lectureId: number): Promise<string> => {
  const { rows } = await query<{ hash: string }>(
    `SELECT md5(COALESCE(string_agg(id::text || ':' || md5(chunk_text), '|' ORDER BY id), '')) AS hash
     FROM lecture_qna_chunks
     WHERE lecture_id = $1`,
    [lectureId]
  );
  return rows[0].hash;
};

// Fetches chunks by id, scoped to the lecture, preserving the requested
// order. A shorter result than `chunkIds` means some chunks no longer exist
// for this lecture — callers use that to invalidate a memory candidate.
export const getChunksByIds = async (lectureId: number, chunkIds: number[]): Promise<QnaChunk[]> => {
  if (chunkIds.length === 0) return [];
  const { rows } = await query<QnaChunk>(
    `SELECT id, lecture_id, topic, question, answer, chunk_text, start_time, end_time, keywords
     FROM lecture_qna_chunks
     WHERE lecture_id = $1 AND id = ANY($2)`,
    [lectureId, chunkIds]
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
  // Set whenever this lookup computed the lecture's content hash, so a
  // later memory write in the same request can reuse it.
  lectureContentHash: string | null;
  // True only when the lookup itself failed (DB/unexpected error) and this
  // is the safe fallback result — distinct from a clean "no match found"
  // miss, for observability (LOOKUP_FAILED vs MISS).
  lookupFailed: boolean;
}

export interface LookupParams {
  studentId: string;
  lectureId: number;
  question: string;
  generateEmbedding: (text: string, isQuery?: boolean) => Promise<number[]>;
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
    AND m.lecture_content_hash = $4
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
    AND m.lecture_content_hash = $3
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
  const failed: MemoryLookupResult = { hit: null, embedding: null, lectureContentHash: null, lookupFailed: true };

  try {
    const normalized = normalizeQuery(question);
    const lectureContentHash = await computeLectureContentHash(lectureId);
    const versionParams = [studentId, lectureId, normalized, lectureContentHash, EMBEDDING_MODEL_VERSION, ANSWER_PROMPT_VERSION];

    // 1. Exact normalized-question match.
    const { rows: exactRows } = await query<{ id: number; answer: string; source_chunk_ids: number[] }>(
      EXACT_LOOKUP_SQL,
      versionParams
    );
    if (exactRows[0]) {
      const candidate = exactRows[0];
      const chunks = await getChunksByIds(lectureId, candidate.source_chunk_ids);
      if (chunks.length === candidate.source_chunk_ids.length) {
        logger.info(`[RAG-MEMORY] memoryExactHit id=${candidate.id}`);
        return {
          hit: { matchType: 'EXACT', memoryId: candidate.id, answer: candidate.answer, sourceChunkIds: candidate.source_chunk_ids, chunks },
          embedding: null,
          lectureContentHash,
          lookupFailed: false,
        };
      }
      logger.warn(`[RAG-MEMORY] memoryInvalidSource id=${candidate.id} (${chunks.length}/${candidate.source_chunk_ids.length} source chunks still exist)`);
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
        logger.info(`[RAG-MEMORY] memoryStale id=${staleRows[0].id} (lecture content, embedding model, or prompt version changed since cached)`);
      }
    }

    // 2. No exact hit — generate the query embedding once. Reused below for
    // semantic lookup and, on a miss, by the caller for lecture retrieval.
    const embedding = await generateEmbedding(question, true);

    // 3. Optional semantic lookup, behind config, disabled by default.
    if (!semanticEnabled) {
      logger.info('[RAG-MEMORY] memoryMiss (semantic disabled)');
      return { hit: null, embedding, lectureContentHash, lookupFailed: false };
    }

    if (threshold === null || threshold === undefined || Number.isNaN(threshold)) {
      logger.warn('[RAG-MEMORY] Semantic memory enabled but RAG_MEMORY_SIMILARITY_THRESHOLD is unset/invalid — skipping semantic lookup');
      return { hit: null, embedding, lectureContentHash, lookupFailed: false };
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    const { rows: semanticRows } = await query<{ id: number; answer: string; source_chunk_ids: number[]; similarity: number }>(
      SEMANTIC_LOOKUP_SQL,
      [studentId, lectureId, lectureContentHash, EMBEDDING_MODEL_VERSION, ANSWER_PROMPT_VERSION, vectorLiteral]
    );

    // Walk ranked candidates best-first: a stale top match (deleted source
    // chunks) shouldn't sink the whole lookup when a valid, still-eligible
    // candidate further down the (small, pre-filtered) list would do.
    for (const candidate of semanticRows) {
      if (candidate.similarity < threshold) break; // rest are equal or weaker (score-sorted)

      const chunks = await getChunksByIds(lectureId, candidate.source_chunk_ids);
      if (chunks.length !== candidate.source_chunk_ids.length) {
        logger.warn(`[RAG-MEMORY] memoryInvalidSource id=${candidate.id} (semantic candidate, ${chunks.length}/${candidate.source_chunk_ids.length} chunks still exist)`);
        continue;
      }

      logger.info(`[RAG-MEMORY] memorySemanticHit id=${candidate.id} similarity=${candidate.similarity.toFixed(3)}`);
      return {
        hit: { matchType: 'SEMANTIC', memoryId: candidate.id, answer: candidate.answer, sourceChunkIds: candidate.source_chunk_ids, chunks, similarity: candidate.similarity },
        embedding,
        lectureContentHash,
        lookupFailed: false,
      };
    }

    logger.info(`[RAG-MEMORY] memoryMiss (semantic, best=${semanticRows[0]?.similarity?.toFixed(3) ?? 'n/a'}, threshold=${threshold})`);
    return { hit: null, embedding, lectureContentHash, lookupFailed: false };
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
  lectureContentHash: string;
}

// Called only after a successful, grounded FACT_QUESTION answer has already
// been saved to chat_history. Never throws — a write failure must never
// change the response already returned to the student. Upserts on the
// (student, lecture, normalized_query, content/model/prompt version)
// uniqueness rule instead of inserting duplicates.
export const writeAnswerMemory = async (params: WriteMemoryParams): Promise<void> => {
  const {
    studentId, lectureId, sourceChatHistoryId, originalQuestion, retrievalQuery,
    answer, sourceChunkIds, questionEmbedding, lectureContentHash,
  } = params;

  if (sourceChunkIds.length === 0) return; // matches the DB CHECK constraint; nothing to cache

  try {
    const normalized = normalizeQuery(originalQuestion);
    const vectorLiteral = `[${questionEmbedding.join(',')}]`;

    await query(
      `INSERT INTO rag_answer_memory (
         student_id, lecture_id, source_chat_history_id,
         original_question, retrieval_query, normalized_query, question_embedding,
         answer, source_chunk_ids, route,
         lecture_content_hash, embedding_model_version, answer_prompt_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,'FACT_QUESTION',$10,$11,$12)
       ON CONFLICT (student_id, lecture_id, normalized_query, lecture_content_hash, embedding_model_version, answer_prompt_version)
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
        lectureContentHash, EMBEDDING_MODEL_VERSION, ANSWER_PROMPT_VERSION,
      ]
    );
    logger.info(`[RAG-MEMORY] memoryEntryCreated lecture=${lectureId} chunks=${sourceChunkIds.length}`);
  } catch (err) {
    logger.warn(`[RAG-MEMORY] memoryWriteFailed: ${(err as Error).message}`);
  }
};
