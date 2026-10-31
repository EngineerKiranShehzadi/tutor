import { AppError } from '../middleware/errorHandler';
import { geminiLlmProvider } from './providers/gemini-llm.provider';
import { groqLlmProvider } from './providers/groq-llm.provider';
import { openAiLlmProvider } from './providers/openai-llm.provider';
import type { LlmProvider } from './providers/llm-provider.interface';

// The one place in the codebase allowed to switch on a provider name.
// Business services never do this themselves — they call
// resolveLlmProvider(env.LLM.<SERVICE>.PROVIDER) and depend only on the
// LlmProvider interface. Adding a new provider means adding one adapter
// under providers/ and one case here — no other file changes.
const PROVIDERS: Record<string, LlmProvider> = {
  gemini: geminiLlmProvider,
  openai: openAiLlmProvider,
  // Temporary free-tier provider for isolated testing (never the default).
  groq: groqLlmProvider,
  // anthropic: anthropicLlmProvider,  — add when an adapter exists. Do not
  // register a name here without a real adapter backing it.
};

export function resolveLlmProvider(name: string): LlmProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new AppError(
      `Unknown LLM provider "${name}" — no adapter is registered for it. Check your .env provider setting.`,
      500
    );
  }
  return provider;
}
