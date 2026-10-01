import type { LlmRequest, LlmResponse } from '../llm.types';

// Every provider adapter (gemini-llm.provider.ts, and any future
// anthropic-llm.provider.ts / openai-llm.provider.ts) implements exactly
// this. Business services never see the provider's own SDK types — only
// this interface and the plain types in llm.types.ts.
export interface LlmProvider {
  // Stable identifier used for observability (llm.provider) and error
  // messages — e.g. 'gemini'.
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
  // Optional: providers that can stream text implement this. Returns the same
  // complete LlmResponse as generate(), after calling onDelta for each piece.
  // Callers must fall back to generate() when it's absent.
  generateStream?(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse>;
}
