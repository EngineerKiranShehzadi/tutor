import { env } from '../config/env';
import { resolveEmbeddingProvider } from '../embedding/embedding-provider.resolver';
import { tracked } from '../observability/provider-signal';

export { EmbeddingUnavailableError, EmbeddingRateLimitedError, EmbeddingQuotaExceededError } from '../embedding/embedding-errors';

const provider = resolveEmbeddingProvider(env.RETRIEVAL.EMBEDDING_PROVIDER);

// Identifies which embedding model/dimensionality produced a stored vector;
// comes from the active embedding provider. Stored vectors and rag_answer_memory
// rows are keyed on it, so a provider/model change means re-embedding.
export const EMBEDDING_MODEL_VERSION = provider.modelVersion;

// Embeds one text with the active provider. isQuery must be true for student
// questions — retrieval models such as BGE treat queries and indexed passages
// differently.
export const generateEmbedding = (text: string, isQuery = false): Promise<number[]> =>
  tracked('embeddingServer', () => provider.embed(text, isQuery));

// Embeds indexed passages (no query prefix) in one request. Same error
// classes as generateEmbedding.
export const generateEmbeddingsBatch = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];
  return tracked('embeddingServer', () => provider.embedBatch(texts));
};
