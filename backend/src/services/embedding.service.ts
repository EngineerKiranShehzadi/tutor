import { logger } from '../utils/logger';

export const LOCAL_EMBED_URL = process.env.EMBEDDING_SERVER_URL ?? 'http://localhost:5001/embed';

// Configurable for the same reason as RERANK_TIMEOUT_MS — see
// rerank.service.ts. Default deliberately unchanged.
export const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 30_000);

// Identifies which embedding model/dimensionality produced a stored vector.
// The local embedding server exposes no model-metadata endpoint, so this is
// a manually-maintained constant — bump it (and re-embed everything that
// depends on it, including rag_answer_memory rows) whenever the server's
// model or output dimensionality changes.
export const EMBEDDING_MODEL_VERSION = 'bge-large-en-v1.5:1024';

// Calls the local Python embedding server (BAAI/bge-large-en-v1.5, 1024 dims).
// isQuery must be true for student questions — BGE prepends a retrieval
// instruction to queries but not to indexed passages.
// Falls back with a clear error if the server is not running.
export const generateEmbedding = async (text: string, isQuery = false): Promise<number[]> => {
  let res: Response;
  try {
    res = await fetch(LOCAL_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, is_query: isQuery }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
  } catch (err) {
    // Distinguish "answered too late" from "not running" — see the same
    // comment in rerank.service.ts for why this matters when debugging.
    if ((err as Error)?.name === 'TimeoutError') {
      throw new Error(
        `Embedding server at ${LOCAL_EMBED_URL} did not respond within ${EMBEDDING_TIMEOUT_MS}ms. ` +
        `It IS running, but it is too slow — usually a sign the machine is short of memory. ` +
        `Raise EMBEDDING_TIMEOUT_MS if this is expected on this machine.`
      );
    }
    throw new Error(
      `Local embedding server not reachable at ${LOCAL_EMBED_URL}. ` +
      `Start it with: python scripts/embedding_server.py`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Embedding server error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  logger.info(`[EMBEDDING] ✅ Generated ${data.embedding.length}-dim vector via local model`);
  return data.embedding;
};
