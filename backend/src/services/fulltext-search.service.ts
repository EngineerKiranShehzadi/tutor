import { query } from '../config/database';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

// Lexical counterpart to vector-search.service.ts's searchChunkCandidates —
// same lecture/version scoping, same shape of result — but ranks by Postgres
// full-text search (search_vector, migration 021) instead of cosine distance.
// Exists to catch near-duplicate-phrasing questions dense embeddings
// under-recall (exact acronyms, code, slide/section numbers — see
// [[rag-audit]] S-R1). Used by searchChunksHybrid (vector-search.service.ts),
// not called directly by the retrieval pipeline.
//
// websearch_to_tsquery is deliberately used over plainto_tsquery: it never
// throws on operator-looking input (a student's question can contain
// "AND"/"OR"/quotes) and treats the query the way a search-engine query box
// would, which is closer to a natural-language question than
// plainto_tsquery's strict AND-of-all-terms.
export const searchChunksFts = async (
  queryText: string,
  lectureId: number,
  topK = 5,
  datasetVersionId?: number
): Promise<(QnaChunk & { ftsRank: number })[]> => {
  const { rows } = await query<QnaChunk & { ftsRank: number }>(
    `SELECT
       id, lecture_id, topic, question, answer,
       chunk_text, chunk_index, start_time, end_time, keywords,
       ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS "ftsRank"
     FROM lecture_qna_chunks
     WHERE lecture_id = $2
       AND id IN (SELECT chunk_id FROM dataset_version_chunks
                  WHERE version_id = COALESCE($4::int, (SELECT active_version_id FROM lectures WHERE id = $2)))
       AND search_vector @@ websearch_to_tsquery('english', $1)
     ORDER BY "ftsRank" DESC
     LIMIT $3`,
    [queryText, lectureId, topK, datasetVersionId ?? null]
  );

  logger.info(`[FTS SEARCH] Lecture #${lectureId}: "${queryText.slice(0, 60)}" → ${rows.length} lexical match(es)`);
  return rows;
};
