import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

export const LOCAL_RERANK_URL = process.env.RERANK_SERVER_URL ?? 'http://localhost:5001/rerank';

// How long to wait for the cross-encoder. Configurable because its speed
// depends entirely on the host: a memory-constrained laptop can take 30s+ for
// 15 candidates, while a normal server does it in a couple of seconds. The
// default stays low on purpose — raising it globally would hide a genuinely
// unhealthy server instead of surfacing it.
export const RERANK_TIMEOUT_MS = Number(process.env.RERANK_TIMEOUT_MS ?? 30_000);

// Identifies which cross-encoder model produced a rerank score. The local
// rerank server exposes no model-metadata endpoint, so this is a
// manually-maintained constant — bump it if the server's model changes.
export const RERANKER_MODEL_VERSION = 'bge-reranker-large';

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
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError; a server that is not
    // listening rejects with a connection error. Reporting both as "not
    // reachable" sends whoever is debugging to go and check a server that is
    // running perfectly well and merely answered late.
    if ((err as Error)?.name === 'TimeoutError') {
      throw new Error(
        `Rerank server at ${LOCAL_RERANK_URL} did not respond within ${RERANK_TIMEOUT_MS}ms. ` +
        `It IS running, but it is too slow — usually a sign the machine is short of memory. ` +
        `Raise RERANK_TIMEOUT_MS if this is expected on this machine.`
      );
    }
    throw new Error(
      `Local rerank server not reachable at ${LOCAL_RERANK_URL}. ` +
      `Start it with: python scripts/embedding_server.py`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rerank server error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { results: { id: number; score: number }[] };
  const byId = new Map(candidates.map(c => [c.id, c]));
  const reranked: QnaChunk[] = [];
  for (const r of data.results.slice(0, topN)) {
    const chunk = byId.get(r.id);
    if (chunk) reranked.push({ ...chunk, rerankScore: r.score });
  }

  logger.info(`[RERANK] ✅ Reranked ${candidates.length} candidates → top ${reranked.length}`);
  return reranked;
};

export const DEFAULT_MIN_RERANK_SCORE = 0.5;

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface DedupeResult {
  selected: QnaChunk[];
  dedupedAway: { keptChunkId: number; droppedChunk: QnaChunk }[];
}

// Collapses chunks that share identical answer text (paraphrase-variant
// questions intentionally repeat the same answer — see diagnose-duplicate-
// answers.ts), backfilling freed slots from further down the SAME already-
// reranked list rather than shrinking the context. `rankedChunks` must be
// sorted best-first with rerankScore populated (i.e. call rerankChunks with
// topN >= desiredCount, ideally the full candidate pool, not just 5).
//
// The dedupe key includes chunk_index alongside the answer text: a long
// answer split into multiple chunks (see chunk.service.ts) stores the SAME
// full `answer` on every piece, so keying on answer text alone would treat
// sibling pieces of one long answer as duplicates of each other and drop
// all but one. Including chunk_index keeps genuine duplicates (same answer,
// same piece index, from different rows) collapsing as before, while
// letting distinct pieces of the same long answer both survive.
//
// A relevance floor prevents backfill from padding weak matches into
// context just to hit desiredCount — same principle as not padding with
// duplicates. Since rankedChunks is score-sorted descending, once a chunk
// falls below the floor every chunk after it is equal or weaker, so we
// stop entirely rather than skip-and-continue.
export const dedupeAndSelect = (
  rankedChunks: QnaChunk[],
  desiredCount = 5,
  minRerankScore = DEFAULT_MIN_RERANK_SCORE
): DedupeResult => {
  const selected: QnaChunk[] = [];
  const dedupedAway: DedupeResult['dedupedAway'] = [];
  const seenAnswers = new Map<string, number>();

  for (const chunk of rankedChunks) {
    if (selected.length >= desiredCount) break;
    if ((chunk.rerankScore ?? 0) < minRerankScore) break;

    const key = `${normalizeAnswer(chunk.answer)}::${chunk.chunk_index ?? 0}`;
    const keptChunkId = seenAnswers.get(key);
    if (keptChunkId !== undefined) {
      dedupedAway.push({ keptChunkId, droppedChunk: chunk });
      continue;
    }
    seenAnswers.set(key, chunk.id);
    selected.push(chunk);
  }

  return { selected, dedupedAway };
};

// Mitigates the "lost in the middle" effect: LLMs attend best to the start
// and end of a prompt, worst to the middle. `chunks` must already be sorted
// best-first (as rerankChunks returns). Interleaves best→front, 2nd-best→back,
// 3rd→front, 4th→back, ... so the single worst chunk lands dead-center.
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
