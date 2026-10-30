import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { createVoyageRerankProvider } from './providers/voyage-rerank.provider';
import { localHttpRerankProvider } from './providers/local-http-rerank.provider';
import type { RerankProvider } from './providers/rerank-provider.interface';

// The one place in the codebase allowed to switch on a rerank provider name.
// Adding a provider means one adapter under providers/ and one entry here —
// no other file changes.
const FACTORIES: Record<string, () => RerankProvider> = {
  'local-http': () => localHttpRerankProvider,
  // Building the adapter never throws for a missing key — assertConfigured()
  // does, at startup.
  voyage: () => createVoyageRerankProvider({
    apiKey: env.RETRIEVAL.VOYAGE_API_KEY,
    model: env.RETRIEVAL.RERANK_MODEL,
  }),
};

const resolved = new Map<string, RerankProvider>();

export function resolveRerankProvider(name: string): RerankProvider {
  const cached = resolved.get(name);
  if (cached) return cached;
  const factory = Object.prototype.hasOwnProperty.call(FACTORIES, name) ? FACTORIES[name] : undefined;
  const provider = factory?.();
  if (!provider) {
    throw new AppError(
      `Unknown rerank provider "${name}" — no adapter is registered for it. Check RERANK_PROVIDER in your .env.`,
      500
    );
  }
  resolved.set(name, provider);
  return provider;
}
