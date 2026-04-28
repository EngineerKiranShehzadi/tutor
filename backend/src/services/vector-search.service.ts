import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const SIMILARITY_THRESHOLD = 0.65;

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
       1 - (embedding <=> $1::vector) AS similarity
     FROM lecture_qna_chunks
     WHERE lecture_id = $2
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral, lectureId, topK]
  );

  // Filter by similarity threshold
  const filtered = rows.filter(r => (r.similarity ?? 0) >= SIMILARITY_THRESHOLD);

  logger.info(
    `[VECTOR SEARCH] Lecture #${lectureId}: ${rows.length} raw results → ${filtered.length} above threshold ${SIMILARITY_THRESHOLD}`
  );

  if (filtered.length === 0 && rows.length > 0) {
    logger.warn(
      `[VECTOR SEARCH] ⚠️  Best similarity was ${rows[0].similarity?.toFixed(3)} — below threshold. Returning top result anyway.`
    );
    return [rows[0]]; // return best match even below threshold as last resort
  }

  return filtered;
};
