import { AppError } from '../middleware/errorHandler';
import { localHttpEmbeddingProvider } from './providers/local-http-embedding.provider';
import type { EmbeddingProvider } from './providers/embedding-provider.interface';

// The one place in the codebase allowed to switch on an embedding provider
// name. Adding a provider means one adapter under providers/ and one entry
// here — no other file changes.
const PROVIDERS: Record<string, EmbeddingProvider> = {
  'local-http': localHttpEmbeddingProvider,
};

export function resolveEmbeddingProvider(name: string): EmbeddingProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new AppError(
      `Unknown embedding provider "${name}" — no adapter is registered for it. Check EMBEDDING_PROVIDER in your .env.`,
      500
    );
  }
  return provider;
}
