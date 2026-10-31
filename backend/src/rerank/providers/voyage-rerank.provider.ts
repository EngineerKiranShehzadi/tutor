import { AppError } from '../../middleware/errorHandler';
import { NetworkError, errorDetail, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import { VOYAGE_API_BASE, probeVoyage } from '../../utils/voyage-api';
import type { RerankCandidate, RerankProvider, RerankScore } from './rerank-provider.interface';

// Voyage AI Reranker API — POST /v1/rerank.
// Request:  { query, documents: string[], model, top_k?, return_documents?, truncation? }
// Response: { object: 'list', data: [{ index, relevance_score }], model, usage: { total_tokens } }
// `data` is documented as sorted by descending relevance_score, and `index` is
// the position in the request's `documents`. At most 1,000 documents per
// request; without top_k every document is scored and returned.
export const VOYAGE_RERANK_URL = `${VOYAGE_API_BASE}/rerank`;
const MAX_DOCUMENTS = 1000;
const TIMEOUT_MS = 30_000;

export interface VoyageRerankConfig {
  apiKey: string;
  model: string;
  retry?: RetryOptions;
}

interface VoyageRerankResponse {
  data?: { index?: number; relevance_score?: number }[];
}

export function createVoyageRerankProvider(config: VoyageRerankConfig): RerankProvider {
  const { apiKey, model } = config;
  const maxRetries = config.retry?.maxRetries ?? 3;

  const assertConfigured = (): void => {
    if (!apiKey) throw new AppError('RERANK_PROVIDER=voyage requires VOYAGE_API_KEY to be set in your .env.', 500);
  };

  return {
    name: 'voyage',
    modelVersion: `voyage:${model}`,
    assertConfigured,

    // Readiness without spending tokens (see utils/voyage-api.ts). The same
    // key serves the Voyage embedder, so a rejected key shows on both cards.
    async probe(): Promise<void> {
      assertConfigured();
      await probeVoyage(apiKey);
    },

    async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]> {
      assertConfigured();
      if (candidates.length > MAX_DOCUMENTS) {
        throw new Error(`Voyage rerank accepts at most ${MAX_DOCUMENTS} documents per request; got ${candidates.length}`);
      }

      let res: Response;
      try {
        res = await postJsonWithRetry(
          VOYAGE_RERANK_URL,
          { Authorization: `Bearer ${apiKey}` },
          { query, documents: candidates.map(c => c.text), model },
          TIMEOUT_MS,
          config.retry,
        );
      } catch (err) {
        if (err instanceof NetworkError) throw new Error(`Voyage rerank not reachable at ${VOYAGE_RERANK_URL}: ${err.message}`);
        throw err;
      }
      if (!res.ok) {
        const detail = await errorDetail(res);
        if (res.status === 401 || res.status === 403) throw new Error(`Voyage rejected the API key (${res.status}) — check VOYAGE_API_KEY: ${detail}`);
        // 429 is a rate limit or a used-up quota, not a down service: say so, so it is actionable.
        if (res.status === 429) throw new Error(`Voyage rerank rate limit or quota exceeded (429) after ${maxRetries} retries: ${detail}`);
        // "service unavailable" so the readiness signal counts every 5xx, not only 503.
        if (res.status >= 500) throw new Error(`Voyage rerank service unavailable (${res.status}) after ${maxRetries} retries: ${detail}`);
        throw new Error(`Voyage rerank error ${res.status}: ${detail}`);
      }

      const data = ((await res.json()) as VoyageRerankResponse).data;
      if (!Array.isArray(data)) throw new Error('Voyage rerank returned no results');
      const seen = new Set<number>();
      const scores: RerankScore[] = data.map(r => {
        const i = r.index;
        if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) {
          throw new Error(`Voyage rerank returned an invalid or duplicate document index (${String(i)})`);
        }
        if (typeof r.relevance_score !== 'number' || !Number.isFinite(r.relevance_score)) {
          throw new Error(`Voyage rerank returned a non-numeric relevance_score for document ${i}`);
        }
        seen.add(i);
        return { id: candidates[i].id, score: r.relevance_score };
      });
      // Every document must come back scored (no top_k is sent): a short reply
      // is an infrastructure fault, never "not in this lecture".
      if (scores.length !== candidates.length) {
        throw new Error(`Rerank returned ${scores.length} scores for ${candidates.length} candidates`);
      }
      // Documented as already descending; sort anyway because callers keep the head.
      return scores.sort((a, b) => b.score - a.score);
    },
  };
}
