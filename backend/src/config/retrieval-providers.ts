import { env } from './env';
import { resolveEmbeddingProvider } from '../embedding/embedding-provider.resolver';
import { resolveRerankProvider } from '../rerank/rerank-provider.resolver';
import { logger } from '../utils/logger';

// VECTOR_SIMILARITY_THRESHOLD and RERANK_MIN_SCORE decide where "answered" ends
// and "not in this lecture" begins, and they were tuned against specific
// providers (the local BGE embedder and bge-reranker-large; CrossEncoder's
// sigmoid makes both 0–1 scores, but e.g. Voyage's relevance_score is
// calibrated differently). Switching a provider without re-tuning silently
// moves that line, so it is refused in production and warned about elsewhere.
export function checkThresholdsTunedFor(): void {
  const active = `${env.RETRIEVAL.EMBEDDING_PROVIDER}:${env.RETRIEVAL.RERANK_PROVIDER}`;
  const tuned = env.RETRIEVAL.THRESHOLDS_TUNED_FOR;
  if (tuned === active) return;
  const message = `Retrieval thresholds were tuned for ${tuned} but providers are ${active} — `
    + 're-run tune:thresholds and update RETRIEVAL_THRESHOLDS_TUNED_FOR';
  if (env.NODE_ENV === 'production') throw new Error(message);
  logger.warn(`[RETRIEVAL] ⚠️  ${message}`);
}

// Fails fast, with one clear message, if the selected embedding / rerank
// provider is missing what it needs (an API key, a usable setting) — so a bad
// deploy stops at startup instead of at the first student question or dataset
// upload. Providers that are not selected are never checked. Makes no network call.
// checkThresholds: false only for tune:thresholds itself, which is how a
// mismatch gets fixed.
export function assertRetrievalProvidersConfigured(opts: { checkThresholds?: boolean } = {}): void {
  resolveEmbeddingProvider(env.RETRIEVAL.EMBEDDING_PROVIDER).assertConfigured();
  resolveRerankProvider(env.RETRIEVAL.RERANK_PROVIDER).assertConfigured();
  if (opts.checkThresholds !== false) checkThresholdsTunedFor();
}
