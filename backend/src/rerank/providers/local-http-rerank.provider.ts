import { NetworkError, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import type { RerankCandidate, RerankProvider, RerankScore } from './rerank-provider.interface';

export const LOCAL_RERANK_URL = process.env.RERANK_SERVER_URL ?? 'http://localhost:5001/rerank';
const TIMEOUT_MS = 30_000;

// Same small bounded retry as the local embedding adapter: rides out a 503
// while the model loads or the queue is full, without stalling the request.
const DEFAULT_RETRY: RetryOptions = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2_000 };

// The local Python cross-encoder (BAAI/bge-reranker-large). It exposes no
// model-metadata endpoint, so the version is a manually-maintained constant —
// bump it if the server's model changes.
const MODEL_VERSION = 'bge-reranker-large';

export function createLocalHttpRerankProvider(retry: RetryOptions = DEFAULT_RETRY): RerankProvider {
  return {
    name: 'local-http',
    modelVersion: MODEL_VERSION,
    healthUrl: LOCAL_RERANK_URL,

    assertConfigured(): void { /* no credentials needed */ },

    async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]> {
      let res: Response;
      try {
        res = await postJsonWithRetry(LOCAL_RERANK_URL, {}, { query, candidates }, TIMEOUT_MS, retry);
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
        throw new Error(
          `Local rerank server not reachable at ${LOCAL_RERANK_URL}. ` +
          `Start it with: python3 scripts/embedding_server.py`
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Rerank server error ${res.status}: ${body}`);
      }

      // Same checks as the hosted adapter: every result names a candidate
      // once and has a finite score. Sorted here because callers keep the head.
      const results = ((await res.json()) as { results?: { id?: unknown; score?: unknown }[] })?.results;
      if (!Array.isArray(results)) throw new Error('Rerank server returned no results');
      const known = new Set(candidates.map(c => c.id));
      const seen = new Set<number>();
      const scores: RerankScore[] = results.map(r => {
        const id = r?.id;
        if (typeof id !== 'number' || !known.has(id) || seen.has(id)) {
          throw new Error(`Rerank server returned an unknown or duplicate candidate id (${String(id)})`);
        }
        if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
          throw new Error(`Rerank server returned a non-numeric score for candidate ${id}`);
        }
        seen.add(id);
        return { id, score: r.score };
      });
      // A short or empty reply silently dropped candidates — and an empty one
      // ended as "not in this lecture" (SUCCESS). It is an infrastructure fault:
      // throwing maps it to RERANKER_FAILURE / ERROR, like the embedding adapters.
      if (scores.length !== candidates.length) {
        throw new Error(`Rerank returned ${scores.length} scores for ${candidates.length} candidates`);
      }
      return scores.sort((a, b) => b.score - a.score);
    },
  };
}

export const localHttpRerankProvider: RerankProvider = createLocalHttpRerankProvider();
