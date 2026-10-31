import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { createOpenAiEmbeddingProvider } from './providers/openai-embedding.provider';
import { localHttpEmbeddingProvider } from './providers/local-http-embedding.provider';
import type { EmbeddingProvider } from './providers/embedding-provider.interface';

// The one place in the codebase allowed to switch on an embedding provider
// name. Adding a provider means one adapter under providers/ and one entry
// here — no other file changes.
// The model each hosted provider uses when EMBEDDING_MODEL is blank, so a
// blank value can never send one provider's model name to another.
export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
};
const modelFor = (name: string): string => env.RETRIEVAL.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODELS[name];

const FACTORIES: Record<string, () => EmbeddingProvider> = {
  'local-http': () => localHttpEmbeddingProvider,
  // Building the adapter never throws for a missing key — assertConfigured()
  // does, at startup — so the model version stays readable without one.
  openai: () => createOpenAiEmbeddingProvider({
    apiKey: env.RETRIEVAL.OPENAI_API_KEY,
    model: modelFor('openai'),
    dimensions: env.RETRIEVAL.EMBEDDING_DIMENSIONS,
  }),
};

const resolved = new Map<string, EmbeddingProvider>();

export function resolveEmbeddingProvider(name: string): EmbeddingProvider {
  const cached = resolved.get(name);
  if (cached) return cached;
  const factory = Object.prototype.hasOwnProperty.call(FACTORIES, name) ? FACTORIES[name] : undefined;
  const provider = factory?.();
  if (!provider) {
    throw new AppError(
      `Unknown embedding provider "${name}" — no adapter is registered for it. Check EMBEDDING_PROVIDER in your .env.`,
      500
    );
  }
  resolved.set(name, provider);
  return provider;
}
