import { logger } from '../utils/logger';

const LOCAL_EMBED_URL = process.env.EMBEDDING_SERVER_URL ?? 'http://localhost:5001/embed';

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
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
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
