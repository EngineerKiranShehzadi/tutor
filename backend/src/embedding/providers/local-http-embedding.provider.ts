import { logger } from '../../utils/logger';
import { EmbeddingUnavailableError } from '../embedding-errors';
import type { EmbeddingProvider } from './embedding-provider.interface';

export const LOCAL_EMBED_URL = process.env.EMBEDDING_SERVER_URL ?? 'http://localhost:5001/embed';
export const LOCAL_EMBED_BATCH_URL = process.env.EMBEDDING_BATCH_SERVER_URL ?? LOCAL_EMBED_URL.replace(/\/embed$/, '/embed_batch');
const EMBEDDING_DIMS = 1024;

// The local Python embedding server (BAAI/bge-large-en-v1.5, 1024 dims).
// It exposes no model-metadata endpoint, so the version is a manually-
// maintained constant — bump it (and re-embed everything that depends on it,
// including rag_answer_memory rows) whenever the server's model or output
// dimensionality changes.
const MODEL_VERSION = 'bge-large-en-v1.5:1024';

export const localHttpEmbeddingProvider: EmbeddingProvider = {
  name: 'local-http',
  modelVersion: MODEL_VERSION,
  dimensions: EMBEDDING_DIMS,
  healthUrl: LOCAL_EMBED_URL,

  assertConfigured(): void { /* no credentials needed */ },

  // isQuery must be true for student questions — BGE prepends a retrieval
  // instruction to queries but not to indexed passages.
  // Fails with a clear error if the server is not running.
  async embed(text: string, isQuery: boolean): Promise<number[]> {
    let res: Response;
    try {
      res = await fetch(LOCAL_EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, is_query: isQuery }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new EmbeddingUnavailableError(
        `Local embedding server not reachable at ${LOCAL_EMBED_URL}. ` +
        `Start it with: python scripts/embedding_server.py`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new EmbeddingUnavailableError(`Embedding server unavailable (${res.status}): ${body}`);
      }
      throw new Error(`Embedding server error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { embedding: number[] };
    logger.info(`[EMBEDDING] ✅ Generated ${data.embedding.length}-dim vector via local model`);
    return data.embedding;
  },

  // Embeds indexed passages (no query prefix) in one request. The reply must
  // have one 1024-dim vector per text.
  async embedBatch(texts: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(LOCAL_EMBED_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new EmbeddingUnavailableError(
        `Local embedding server not reachable at ${LOCAL_EMBED_BATCH_URL}. ` +
        `Start it with: python scripts/embedding_server.py`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new EmbeddingUnavailableError(`Embedding server unavailable (${res.status}): ${body}`);
      }
      throw new Error(`Embedding server error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(`Embedding server returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} vectors for ${texts.length} texts`);
    }
    const bad = embeddings.findIndex(e => !Array.isArray(e) || e.length !== EMBEDDING_DIMS);
    if (bad !== -1) {
      throw new Error(`Embedding server returned a ${embeddings[bad]?.length}-dim vector at index ${bad}; expected ${EMBEDDING_DIMS}`);
    }
    logger.info(`[EMBEDDING] ✅ Generated ${embeddings.length} ${EMBEDDING_DIMS}-dim vectors in one batch`);
    return embeddings;
  },
};
