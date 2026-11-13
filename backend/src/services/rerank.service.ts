import { QnaChunk } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { resolveRerankProvider } from '../rerank/rerank-provider.resolver';
import { tracked } from '../observability/provider-signal';

const provider = resolveRerankProvider(env.RETRIEVAL.RERANK_PROVIDER);

// Identifies which model produced a rerank score; never substitute cosine
// scores here. The raw candidate pool no longer has a cosine admission gate.
export const RERANKER_MODEL_VERSION = provider.modelVersion;

export const rerankChunks = async (
  question: string,
  candidates: QnaChunk[],
  topN = 5
): Promise<QnaChunk[]> => {
  if (candidates.length === 0) return [];
  if (!Number.isInteger(topN) || topN < 1) throw new Error('Invalid reranker result limit');

  try {
    const byId = new Map(candidates.map(c => [c.id, c]));
    if (byId.size !== candidates.length) throw new Error('Duplicate reranker candidate IDs');
    const scores = await tracked('reranker', async () => {
      const response = await provider.rerank(
        question,
        candidates.map(c => ({ id: c.id, text: c.chunk_text }))
      );
      // Guard every provider, including local/custom adapters. Missing,
      // duplicated, unknown or non-finite scores are outages/bad responses,
      // not "no evidence" and never permission to use raw top-K as context.
      if (!Array.isArray(response) || response.length !== candidates.length) {
        throw new Error('Reranker returned an incomplete score set');
      }
      const seen = new Set<number>();
      for (const result of response) {
        if (!result || !byId.has(result.id) || seen.has(result.id) ||
            typeof result.score !== 'number' || !Number.isFinite(result.score)) {
          throw new Error('Reranker returned an invalid score set');
        }
        seen.add(result.id);
      }
      return [...response].sort((a, b) => b.score - a.score);
    });

    const reranked = scores.slice(0, topN).map(r => ({ ...byId.get(r.id)!, rerankScore: r.score }));
    logger.info(`[RERANK] input=${candidates.length} validated=${scores.length} returned=${reranked.length} reason=RERANK_SCORED`);
    return reranked;
  } catch (err) {
    logger.warn(`[RERANK] input=${candidates.length} reason=RERANKER_FAILURE rawFallbackBlocked=true`);
    // Existing chat error handling reports RERANKER_FAILURE. Subquery/adaptive
    // handling marks the affected aspect unavailable. Never return candidates
    // or manufacture rerankScore from cosine similarity on this path.
    throw err;
  }
};

export const DEFAULT_MIN_RERANK_SCORE = env.RETRIEVAL.RERANK_MIN_SCORE;

export function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface DedupeResult {
  selected: QnaChunk[];
  dedupedAway: { keptChunkId: number; droppedChunk: QnaChunk }[];
}

// Input must be reranker-scored, best-first. Preserve the existing answer +
// chunk_index key: different pieces of a long answer are NOT duplicates.
// Backfill from the SAME ranked pool; never pad context with weak matches.
export const dedupeAndSelect = (
  rankedChunks: QnaChunk[],
  desiredCount = 5,
  minRerankScore = DEFAULT_MIN_RERANK_SCORE
): DedupeResult => {
  if (!Number.isFinite(minRerankScore)) throw new Error('Invalid reranker relevance floor');
  if (!Number.isInteger(desiredCount) || desiredCount < 0) throw new Error('Invalid context budget');
  const selected: QnaChunk[] = [];
  const dedupedAway: DedupeResult['dedupedAway'] = [];
  const seenAnswers = new Map<string, number>();
  const validScore = (c: QnaChunk): boolean =>
    typeof c.rerankScore === 'number' && Number.isFinite(c.rerankScore);
  const invalidScoreCount = rankedChunks.filter(c => !validScore(c)).length;
  const belowFloorCount = rankedChunks.filter(c => validScore(c) && c.rerankScore! < minRerankScore).length;

  for (const chunk of rankedChunks) {
    if (selected.length >= desiredCount) break;
    // Defence in depth for injected/alternate callers: an absent/NaN score
    // cannot pass the floor, even when a threshold happens to be zero.
    if (!validScore(chunk)) continue;
    if (chunk.rerankScore! < minRerankScore) break;

    const key = `${normalizeAnswer(chunk.answer)}::${chunk.chunk_index ?? 0}`;
    const keptChunkId = seenAnswers.get(key);
    if (keptChunkId !== undefined) {
      dedupedAway.push({ keptChunkId, droppedChunk: chunk });
      continue;
    }
    seenAnswers.set(key, chunk.id);
    selected.push(chunk);
  }

  const beyondBudget = Math.max(0, rankedChunks.length - invalidScoreCount - belowFloorCount - dedupedAway.length - selected.length);
  logger.info(`[RERANK SELECTION] input=${rankedChunks.length} selected=${selected.length} belowFloor=${belowFloorCount} invalidScores=${invalidScoreCount} deduped=${dedupedAway.length} beyondBudget=${beyondBudget} floor=${minRerankScore} reason=${selected.length ? 'SELECTED' : 'NO_QUALIFYING_RERANKED_EVIDENCE'}`);
  return { selected, dedupedAway };
};

// Best and second-best chunks at the prompt edges; worst in the middle.
// Citation order is preserved by the caller, separate from context order.
export const reorderForContext = (chunks: QnaChunk[]): QnaChunk[] => {
  const result = new Array<QnaChunk>(chunks.length);
  let left = 0;
  let right = chunks.length - 1;
  chunks.forEach((chunk, i) => {
    if (i % 2 === 0) {
      result[left++] = chunk;
    } else {
      result[right--] = chunk;
    }
  });
  return result;
};
