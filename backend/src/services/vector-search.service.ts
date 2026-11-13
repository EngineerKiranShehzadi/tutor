import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getActiveTrace } from '../observability/tracer';
import { searchChunksFts } from './fulltext-search.service';

// Retained for diagnostics/threshold tuning, NOT an admission gate before
// reranking. Cosine similarity and a cross-encoder score are different signals.
export const SIMILARITY_THRESHOLD = env.RETRIEVAL.VECTOR_SIMILARITY_THRESHOLD;

type ScoredChunk = QnaChunk & { similarity: number };

// Searches only one lecture and its pinned (or currently ACTIVE) version.
// Returns the bounded raw top-K. Every answer-producing caller MUST rerank
// these candidates and apply the reranker relevance floor before generation.
export const searchChunkCandidates = async (
  embedding: number[],
  lectureId: number,
  topK = 5,
  datasetVersionId?: number
): Promise<ScoredChunk[]> => {
  const vectorLiteral = `[${embedding.join(',')}]`;
  const run = async (): Promise<ScoredChunk[]> => {
    try {
      const { rows } = await query<ScoredChunk>(
        `SELECT
           id, lecture_id, topic, question, answer,
           chunk_text, chunk_index, start_time, end_time, keywords,
           1 - (local_embedding <=> $1::vector) AS similarity
         FROM lecture_qna_chunks
         WHERE lecture_id = $2
           AND id IN (SELECT chunk_id FROM dataset_version_chunks
                      WHERE version_id = COALESCE($4::int, (SELECT active_version_id FROM lectures WHERE id = $2)))
           AND local_embedding IS NOT NULL
         ORDER BY local_embedding <=> $1::vector
         LIMIT $3`,
        [vectorLiteral, lectureId, topK, datasetVersionId ?? null]
      );
      const belowLegacyFloor = rows.filter(r => r.similarity < SIMILARITY_THRESHOLD).length;
      logger.info(`[VECTOR SEARCH] lecture=${lectureId} raw=${rows.length} forwarded=${rows.length} belowLegacyFloor=${belowLegacyFloor} thresholdApplied=false reason=${rows.length ? 'DEFER_TO_RERANKER' : 'NO_VECTOR_CANDIDATES'}`);
      return rows;
    } catch (err) {
      logger.warn(`[VECTOR SEARCH] lecture=${lectureId} reason=VECTOR_SEARCH_FAILURE`);
      throw err; // A database failure is NOT evidence that the topic is absent.
    }
  };
  const trace = getActiveTrace();
  return trace ? trace.span('collect-vector-candidates', run, rows => ({
    lectureId,
    datasetVersionId: datasetVersionId ?? null,
    candidateLimit: topK,
    rawVectorCount: rows.length,
    forwardedVectorCount: rows.length,
    belowLegacyVectorFloor: rows.filter(r => r.similarity < SIMILARITY_THRESHOLD).length,
    legacyVectorThreshold: SIMILARITY_THRESHOLD,
    vectorThresholdApplied: false,
    selectionReason: rows.length ? 'DEFER_TO_RERANKER' : 'NO_VECTOR_CANDIDATES',
    candidateIds: rows.map(r => r.id).join(','),
  })) : run();
};

// Vector-only path used by decomposed/adaptive retrieval and by chat when
// hybrid search is disabled. It has the SAME reranker-first admission policy.
export const searchChunks = async (
  embedding: number[],
  lectureId: number,
  topK = 5,
  datasetVersionId?: number
): Promise<QnaChunk[]> => searchChunkCandidates(embedding, lectureId, topK, datasetVersionId);

// Bounded vector + lexical retrieval, still in parallel, fused with the
// existing Reciprocal Rank Fusion ordering. Deduplicate by chunk ID, not
// answer text (answer/piece dedup happens AFTER reranking). Do not discard a
// vector hit at 0.55: known outcomes/typo evidence scored below that floor.
// FTS failure remains best-effort; vector/database failures still propagate.
export const searchChunksHybrid = async (
  embedding: number[],
  queryText: string,
  lectureId: number,
  topK = 5,
  datasetVersionId?: number
): Promise<QnaChunk[]> => {
  if (!env.RETRIEVAL.HYBRID_SEARCH_ENABLED) {
    return searchChunks(embedding, lectureId, topK, datasetVersionId);
  }

  let vectorCount = 0;
  let ftsCount = 0;
  let belowLegacyFloor = 0;
  let ftsUnavailable = false;
  const run = async (): Promise<QnaChunk[]> => {
    const vectorRowsPromise = searchChunkCandidates(embedding, lectureId, topK, datasetVersionId);
    const ftsRowsPromise = searchChunksFts(queryText, lectureId, topK, datasetVersionId)
      .catch(() => {
        ftsUnavailable = true;
        logger.warn(`[HYBRID SEARCH] lecture=${lectureId} reason=FTS_UNAVAILABLE_VECTOR_ONLY`);
        return [] as (QnaChunk & { ftsRank: number })[];
      });
    const [vectorRows, ftsRows] = await Promise.all([vectorRowsPromise, ftsRowsPromise]);
    vectorCount = vectorRows.length;
    ftsCount = ftsRows.length;
    belowLegacyFloor = vectorRows.filter(r => r.similarity < SIMILARITY_THRESHOLD).length;

    const k = env.RETRIEVAL.RRF_K;
    const fusedScore = new Map<number, number>();
    const byId = new Map<number, QnaChunk>();
    vectorRows.forEach((r, rank) => {
      byId.set(r.id, r);
      fusedScore.set(r.id, (fusedScore.get(r.id) ?? 0) + 1 / (k + rank + 1));
    });
    ftsRows.forEach((r, rank) => {
      if (!byId.has(r.id)) byId.set(r.id, r);
      fusedScore.set(r.id, (fusedScore.get(r.id) ?? 0) + 1 / (k + rank + 1));
    });

    // Each input is topK-bounded, so the union contains at most 2 * topK.
    const candidates = [...byId.values()];
    candidates.sort((a, b) => (fusedScore.get(b.id) ?? 0) - (fusedScore.get(a.id) ?? 0));
    logger.info(`[HYBRID SEARCH] lecture=${lectureId} vector=${vectorCount} fts=${ftsCount} merged=${candidates.length} belowLegacyFloor=${belowLegacyFloor} thresholdApplied=false reason=${candidates.length ? 'DEFER_TO_RERANKER' : 'NO_RETRIEVAL_CANDIDATES'}`);
    return candidates;
  };
  const trace = getActiveTrace();
  return trace ? trace.span('merge-retrieval-candidates', run, rows => ({
    lectureId,
    datasetVersionId: datasetVersionId ?? null,
    rawVectorCount: vectorCount,
    lexicalCandidateCount: ftsCount,
    mergedCandidateCount: rows.length,
    belowLegacyVectorFloor: belowLegacyFloor,
    vectorThresholdApplied: false,
    ftsUnavailable,
    selectionReason: rows.length ? 'DEFER_TO_RERANKER' : 'NO_RETRIEVAL_CANDIDATES',
    candidateIds: rows.map(r => r.id).join(','),
  })) : run();
};
