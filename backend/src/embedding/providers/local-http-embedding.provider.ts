import { logger } from '../../utils/logger';
import { NetworkError, postJsonWithRetry, type RetryOptions } from '../../utils/http-retry';
import { EMBEDDING_COLUMN_DIMS } from '../embedding-dimensions';
import { EmbeddingUnavailableError } from '../embedding-errors';
import type { EmbeddingProvider } from './embedding-provider.interface';

export const LOCAL_EMBED_URL = process.env.EMBEDDING_SERVER_URL ?? 'http://localhost:5001/embed';
export const LOCAL_EMBED_BATCH_URL = process.env.EMBEDDING_BATCH_SERVER_URL ?? LOCAL_EMBED_URL.replace(/\/embed$/, '/embed_batch');
const EMBEDDING_DIMS = EMBEDDING_COLUMN_DIMS;
const SINGLE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 120_000;

// A local server answers 503 while the model is still loading or the queue is
// full; a couple of quick retries ride that out. Kept small because the query
// path is waiting on it.
const DEFAULT_RETRY: RetryOptions = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2_000 };

// The local Python embedding server (BAAI/bge-large-en-v1.5, 1024 dims).
// It exposes no model-metadata endpoint, so the version is a manually-
// maintained constant — bump it (and re-embed everything that depends on it,
// including rag_answer_memory rows) whenever the server's model or output
// dimensionality changes.
const MODEL_VERSION = 'bge-large-en-v1.5:1024';

// Every vector must have the database column's width and only finite numbers.
function assertVector(v: unknown, where: string): asserts v is number[] {
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS) {
    throw new Error(`Embedding server returned ${Array.isArray(v) ? `a ${v.length}-dim vector` : 'no vector'}${where}; expected ${EMBEDDING_DIMS} dims`);
  }
  if (v.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`Embedding server returned a non-numeric value in the vector${where}`);
  }
}

export function createLocalHttpEmbeddingProvider(retry: RetryOptions = DEFAULT_RETRY): EmbeddingProvider {
  // POST with bounded retry. Unreachable, or still 502/503/504 after the
  // retries, is EmbeddingUnavailableError (the dataset pipeline waits on it);
  // any other non-2xx is a plain error.
  const post = async (url: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    let res: Response;
    try {
      res = await postJsonWithRetry(url, {}, body, timeoutMs, retry);
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
      throw new EmbeddingUnavailableError(
        `Local embedding server not reachable at ${url}. ` +
        `Start it with: python scripts/embedding_server.py`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new EmbeddingUnavailableError(`Embedding server unavailable (${res.status}): ${text}`);
      }
      throw new Error(`Embedding server error ${res.status}: ${text}`);
    }
    return res.json();
  };

  return {
    name: 'local-http',
    modelVersion: MODEL_VERSION,
    dimensions: EMBEDDING_DIMS,
    healthUrl: LOCAL_EMBED_URL,

    assertConfigured(): void { /* no credentials needed */ },

    // isQuery must be true for student questions — BGE prepends a retrieval
    // instruction to queries but not to indexed passages.
    async embed(text: string, isQuery: boolean): Promise<number[]> {
      const data = (await post(LOCAL_EMBED_URL, { text, is_query: isQuery }, SINGLE_TIMEOUT_MS)) as { embedding?: unknown };
      assertVector(data?.embedding, '');
      logger.info(`[EMBEDDING] ✅ Generated ${data.embedding.length}-dim vector via local model`);
      return data.embedding;
    },

    // Embeds indexed passages (no query prefix) in one request. The reply must
    // have one 1024-dim vector per text.
    async embedBatch(texts: string[]): Promise<number[][]> {
      const data = (await post(LOCAL_EMBED_BATCH_URL, { texts }, BATCH_TIMEOUT_MS)) as { embeddings?: unknown };
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(`Embedding server returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} vectors for ${texts.length} texts`);
      }
      embeddings.forEach((e, i) => assertVector(e, ` at index ${i}`));
      logger.info(`[EMBEDDING] ✅ Generated ${embeddings.length} ${EMBEDDING_DIMS}-dim vectors in one batch`);
      return embeddings as number[][];
    },
  };
}

export const localHttpEmbeddingProvider: EmbeddingProvider = createLocalHttpEmbeddingProvider();
