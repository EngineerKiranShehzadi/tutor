import { AppError } from '../middleware/errorHandler';
import { localHttpRerankProvider } from './providers/local-http-rerank.provider';
import type { RerankProvider } from './providers/rerank-provider.interface';

// The one place in the codebase allowed to switch on a rerank provider name.
// Adding a provider means one adapter under providers/ and one entry here —
// no other file changes.
const PROVIDERS: Record<string, RerankProvider> = {
  'local-http': localHttpRerankProvider,
};

export function resolveRerankProvider(name: string): RerankProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new AppError(
      `Unknown rerank provider "${name}" — no adapter is registered for it. Check RERANK_PROVIDER in your .env.`,
      500
    );
  }
  return provider;
}
