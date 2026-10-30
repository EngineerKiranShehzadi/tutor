import type { RerankCandidate, RerankProvider, RerankScore } from './rerank-provider.interface';

export const LOCAL_RERANK_URL = process.env.RERANK_SERVER_URL ?? 'http://localhost:5001/rerank';

// The local Python cross-encoder (BAAI/bge-reranker-large). It exposes no
// model-metadata endpoint, so the version is a manually-maintained constant —
// bump it if the server's model changes.
const MODEL_VERSION = 'bge-reranker-large';

export const localHttpRerankProvider: RerankProvider = {
  name: 'local-http',
  modelVersion: MODEL_VERSION,
  healthUrl: LOCAL_RERANK_URL,

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]> {
    let res: Response;
    try {
      res = await fetch(LOCAL_RERANK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, candidates }),
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

    const data = (await res.json()) as { results: RerankScore[] };
    return data.results;
  },
};
