import type { LlmRequest, LlmResponse } from '../llm.types';

// Every provider adapter (openai-llm.provider.ts, groq-llm.provider.ts, and
// any future one) implements exactly this.
// Business services never see the provider's own SDK types — only this
// interface and the plain types in llm.types.ts.
export interface LlmProvider {
  // Stable identifier used for observability (llm.provider) and error
  // messages — e.g. 'openai'.
  readonly name: string;
  // Throws a clear error if the provider cannot work as configured (missing
  // API key). No network call. Run at startup for every selected provider
  // (config/llm-providers.ts), so a missing key shows at boot, not at the
  // first student question.
  assertConfigured?(): void;
  // Readiness probe that spends no tokens (e.g. model metadata): proves the key
  // works, the API is reachable and `model` is available. Throws on failure.
  probe?(model: string): Promise<void>;
  generate(request: LlmRequest): Promise<LlmResponse>;
  // Optional: providers that can stream text implement this. Returns the same
  // complete LlmResponse as generate(), after calling onDelta for each piece.
  // Callers must fall back to generate() when it's absent.
  generateStream?(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse>;
}
