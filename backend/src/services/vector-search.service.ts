import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { searchChunksFts } from './fulltext-search.service';

export const SIMILARITY_THRESHOLD = env.RETRIEVAL.VECTOR_SIMILARITY_THRESHOLD;

// Searches only the specified lecture's chunks using pgvector cosine similarity,
// and only those in the lecture's ACTIVE dataset version — chunks of a version
// still being built (or of an older one) are never returned. Returns the top-K
// by similarity with NO threshold applied; searchChunks() is the production
// entry point that enforces it, and the threshold tuner reads this directly.
export const searchChunkCandidates = async (
  embedding: number[],
  lectureId: number,
  topK = 5,
  // Pin the search to one dataset version. A chat request resolves the version
  // once at its start and passes it to every retrieval call, so a publish that
  // lands mid-request can never mix two versions' chunks into one answer.
  // Omitted: the lecture's active version at query time.
  datasetVersionId?: number
): Promise<(QnaChunk & { similarity: number })[]> => {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const { rows } = await query<QnaChunk & { similarity: number }>(
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

  return rows;
};

export const searchChunks = async (
  embedding: number[],
  lectureId: number,
  topK = 5,
  datasetVersionId?: number
): Promise<QnaChunk[]> => {
  const rows = await searchChunkCandidates(embedding, lectureId, topK, datasetVersionId);

  // Filter by similarity threshold — strictly enforced
  const filtered = rows.filter(r => (r.similarity ?? 0) >= SIMILARITY_THRESHOLD);

  logger.info(
    `[VECTOR SEARCH] Lecture #${lectureId}: ${rows.length} raw results → ${filtered.length} above threshold ${SIMILARITY_THRESHOLD}`
  );

  if (filtered.length === 0) {
    logger.warn(
      `[VECTOR SEARCH] ⚠️  No chunks met threshold ${SIMILARITY_THRESHOLD} (best=${rows[0]?.similarity?.toFixed(3) ?? 'n/a'}) — returning empty`
    );
  }

  return filtered;
};

// Hybrid search (2026-11-03, Finding 2 of the RAG test, S-R1): runs vector
// search and full-text search in parallel and fuses them with Reciprocal
// Rank Fusion, so a chunk that one signal misses but the other finds
// strongly (a near-duplicate "slide 14"-vs-"slide 15" question is the
// motivating case — see fulltext-search.service.ts) still surfaces.
//
// A pure RRF score has no natural "did this clear the bar" cutoff the way
// cosine similarity does, so the existing threshold is kept as a *floor*,
// not replaced: a chunk is returned if it individually passed the vector
// threshold OR individually passed the FTS floor (appears at all — FTS
// is binary match/no-match per row via `@@`, ts_rank_cd only orders
// the matches). RRF only decides the merged *order* those survivors come
// back in, which feeds straight into the existing reranker exactly like
// searchChunks()'s output always has — this is a wider, better-ordered
// candidate pool for the same downstream rerank+floor logic, not a new
// decision stage.
//
// FTS runs best-effort: a lexical-search failure (bad input, index issue)
// never takes down retrieval — it just falls back to vector-only, same
// as the existing fail-open convention for the reranker (S-R3).
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

  const vectorRowsPromise = searchChunkCandidates(embedding, lectureId, topK, datasetVersionId);
  const ftsRowsPromise = searchChunksFts(queryText, lectureId, topK, datasetVersionId)
    .catch(err => {
      logger.warn(`[HYBRID SEARCH] ⚠️  Full-text search failed, continuing vector-only: ${(err as Error).message}`);
      return [] as (QnaChunk & { ftsRank: number })[];
    });

  const [vectorRows, ftsRows] = await Promise.all([vectorRowsPromise, ftsRowsPromise]);

  const vectorPass = new Set(vectorRows.filter(r => (r.similarity ?? 0) >= SIMILARITY_THRESHOLD).map(r => r.id));
  const ftsPass = new Set(ftsRows.map(r => r.id));

  // RRF: each list contributes 1/(k + rank) to a chunk's fused score —
  // chunks in both lists accumulate both contributions. k=RRF_K dampens how
  // much a single list's exact rank dominates (standard choice, k=60).
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

  const survivors = [...byId.values()].filter(c => vectorPass.has(c.id) || ftsPass.has(c.id));
  survivors.sort((a, b) => (fusedScore.get(b.id) ?? 0) - (fusedScore.get(a.id) ?? 0));

  logger.info(
    `[HYBRID SEARCH] Lecture #${lectureId}: vector ${vectorRows.length} (${vectorPass.size} above threshold) + ` +
    `fts ${ftsRows.length} → fused ${survivors.length} distinct candidate(s)`
  );

  return survivors;
};
