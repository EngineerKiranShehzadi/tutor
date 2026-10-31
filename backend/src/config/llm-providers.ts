import { env } from './env';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { logger } from '../utils/logger';

// Which provider each LLM task is configured for (env.LLM.<TASK>.PROVIDER),
// grouped by provider: { openai: ['RAG_ANSWER', 'QUERY_ROUTER', …] }.
export function selectedLlmProviders(llm: Record<string, unknown> = env.LLM): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [task, cfg] of Object.entries(llm)) {
    const provider = (cfg as { PROVIDER?: unknown })?.PROVIDER;
    if (typeof provider !== 'string' || provider === '') continue;
    out.set(provider, [...(out.get(provider) ?? []), task]);
  }
  return out;
}

// Startup check for the LLM side, the counterpart of
// assertRetrievalProvidersConfigured. Makes no network call; providers no task
// selects are never checked.
//  - A provider name with no adapter (a typo) stops startup in every environment.
//  - A selected provider without its API key stops a production start. In
//    development it is a loud warning instead: a teammate without keys can still
//    run the admin side (START_HERE.md), and that task's first call fails with
//    the same message.
export function assertLlmProvidersConfigured(nodeEnv: string = env.NODE_ENV, llm: Record<string, unknown> = env.LLM): void {
  for (const [name, tasks] of selectedLlmProviders(llm)) {
    const provider = resolveLlmProvider(name);
    try {
      provider.assertConfigured?.();
    } catch (err) {
      const message = `${(err as Error).message} (used by ${tasks.join(', ')})`;
      if (nodeEnv === 'production') throw new Error(message);
      logger.warn(`[LLM] ⚠️  ${message}`);
    }
  }
}
