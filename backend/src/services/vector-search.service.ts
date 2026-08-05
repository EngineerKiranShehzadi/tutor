import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

export const SIMILARITY_THRESHOLD = 0.55;

// Searches only the specified lecture's chunks using pgvector cosine similarity
export const searchChunks = async (
  embedding: number[],
  lectureId: number,
  topK = 5
): Promise<QnaChunk[]> => {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const { rows } = await query<QnaChunk & { similarity: number }>(
    `SELECT
       id, lecture_id, topic, question, answer,
       chunk_text, start_time, end_time, keywords,
       1 - (local_embedding <=> $1::vector) AS similarity
     FROM lecture_qna_chunks
     WHERE lecture_id = $2
       AND local_embedding IS NOT NULL
     ORDER BY local_embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral, lectureId, topK]
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
