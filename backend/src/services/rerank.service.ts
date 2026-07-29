import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

const LOCAL_RERANK_URL = process.env.RERANK_SERVER_URL ?? 'http://localhost:5001/rerank';

// Calls the local Python cross-encoder (BAAI/bge-reranker-large) to reorder
// candidate chunks by precise query-chunk relevance, then returns the top N.
export const rerankChunks = async (
  question: string,
  candidates: QnaChunk[],
  topN = 5
): Promise<QnaChunk[]> => {
  if (candidates.length === 0) return [];

  let res: Response;
  try {
    res = await fetch(LOCAL_RERANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: question,
        candidates: candidates.map(c => ({ id: c.id, text: c.chunk_text })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Local rerank server not reachable at ${LOCAL_RERANK_URL}. ` +
      `Start it with: python3 scripts/embedding_server.py`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rerank server error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { results: { id: number; score: number }[] };
  const byId = new Map(candidates.map(c => [c.id, c]));
  const reranked = data.results
    .slice(0, topN)
    .map(r => byId.get(r.id))
    .filter((c): c is QnaChunk => Boolean(c));

  logger.info(`[RERANK] ✅ Reranked ${candidates.length} candidates → top ${reranked.length}`);
  return reranked;
};
