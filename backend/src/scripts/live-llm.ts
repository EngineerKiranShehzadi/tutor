/**
 * Shared by the scripts that make REAL LLM calls (evaluations, the judge
 * check, live quality checks). They use the configured providers and models
 * from env.LLM, never a hardcoded provider, and they spend real tokens.
 */
import { env } from '../config/env';
import { assertLlmProvidersConfigured } from '../config/llm-providers';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';

// Stops with one clear line, before any call is made, when a selected LLM
// provider has no key (e.g. "OPENAI_API_KEY is not set").
export function requireLiveLlm(): void {
  try {
    assertLlmProvidersConfigured('production');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

// The evaluation judge: the answer-verification task's provider and model,
// at temperature 0 with reasoning off. Returns the raw text reply.
export const JUDGE_MODEL = env.LLM.ANSWER_VERIFICATION.MODEL;
export async function judgeLlm(prompt: string): Promise<string> {
  const cfg = env.LLM.ANSWER_VERIFICATION;
  const r = await resolveLlmProvider(cfg.PROVIDER).generate({ model: cfg.MODEL, userPrompt: prompt, temperature: 0, thinking: 'off' });
  return r.raw;
}

// A free-form answer on the answer task's provider and model.
export async function answerLlm(prompt: string, opts: { temperature?: number; maxOutputTokens?: number } = {}): Promise<string> {
  const cfg = env.LLM.RAG_ANSWER;
  const r = await resolveLlmProvider(cfg.PROVIDER).generate({ model: cfg.MODEL, userPrompt: prompt, thinking: cfg.THINKING, ...opts });
  return r.raw;
}
