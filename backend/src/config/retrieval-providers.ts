import { env } from './env';
import { resolveEmbeddingProvider } from '../embedding/embedding-provider.resolver';
import { resolveRerankProvider } from '../rerank/rerank-provider.resolver';

// Fails fast, with one clear message, if the selected embedding / rerank
// provider is missing what it needs (an API key, a usable setting) — so a bad
// deploy stops at startup instead of at the first student question or dataset
// upload. Providers that are not selected are never checked. Makes no network call.
export function assertRetrievalProvidersConfigured(): void {
  resolveEmbeddingProvider(env.RETRIEVAL.EMBEDDING_PROVIDER).assertConfigured();
  resolveRerankProvider(env.RETRIEVAL.RERANK_PROVIDER).assertConfigured();
}
