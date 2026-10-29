import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

export const SIMILARITY_THRESHOLD = 0.55;

// Searches only the specified lecture's chunks using pgvector cosine similarity,
// and only those in the lecture's ACTIVE dataset version — chunks of a version
// still being built (or of an older one) are never returned.
export const searchChunks = async (
  embedding: number[],
  lectureId: number,
  topK = 5,
  // Pin the search to one dataset version. A chat request resolves the version
  // once at its start and passes it to every retrieval call, so a publish that
  // lands mid-request can never mix two versions' chunks into one answer.
  // Omitted: the lecture's active version at query time.
  datasetVersionId?: number
): Promise<QnaChunk[]> => {
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
