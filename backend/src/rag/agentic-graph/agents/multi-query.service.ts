// Multi-Query expansion — NEW, Phase 2.
//
// Generates a few paraphrases of the query from different angles. Each is
// retrieved for separately and the candidate sets are fused (dedupe by chunk
// id) before reranking — this lifts recall when the student's phrasing differs
// from the lecture's wording.
//
//  - Returns 0..N paraphrases (NOT including the original — the caller adds
//    that). Capped so retrieval cost stays bounded.
//  - FAIL-OPEN: on any error return [] (caller falls back to the single query).
//  - Temperature 0 for reproducibility.
import { z } from 'zod';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { logger } from '../../../utils/logger';

export interface MultiQueryTaskConfig {
  PROVIDER: string;
  MODEL: string;
  TIMEOUT_MS: number;
  TEMPERATURE: number;
}

// Hard cap on paraphrases, independent of what the model returns.
export const MAX_PARAPHRASES = 3;

const MULTIQUERY_SYSTEM_PROMPT =
  'You rewrite a lecture question into a few alternative search queries that mean ' +
  'the same thing but use different wording, synonyms, or angle — to improve ' +
  'retrieval. Return strict JSON: {"queries": string[]}. Give at most 3, each a ' +
  'self-contained query, none identical to the original. If the question is already ' +
  'optimal, return an empty array.';

const MultiQueryResponse = z.object({
  queries: z.array(z.string()).default([]),
});

export async function expandMultiQuery(query: string, cfg: MultiQueryTaskConfig): Promise<string[]> {
  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await withLlmDiagnostic(
      {
        spanName: 'multi_query_call',
        operationType: 'MULTI_QUERY_EXPANSION',
        provider: provider.name,
        model: cfg.MODEL,
        invocationParams: { temperature: cfg.TEMPERATURE, timeoutMs: cfg.TIMEOUT_MS },
      },
      () => provider.generate({
        model: cfg.MODEL,
        systemPrompt: MULTIQUERY_SYSTEM_PROMPT,
        userPrompt: `Original query:\n${query}`,
        temperature: cfg.TEMPERATURE,
        timeoutMs: cfg.TIMEOUT_MS,
      } as Parameters<typeof provider.generate>[0]),
      extractLlmUsage,
    );

    const parsed = MultiQueryResponse.safeParse(JSON.parse((result as { raw: string }).raw));
    if (!parsed.success) {
      logger.warn('[MULTI-QUERY] invalid structured output — skipping expansion');
      return [];
    }
    return parsed.data.queries
      .map(q => q.trim())
      .filter(q => q.length > 0 && q !== query)
      .slice(0, MAX_PARAPHRASES);
  } catch (err) {
    logger.warn(`[MULTI-QUERY] ⚠️ expansion failed, skipping: ${(err as Error).message}`);
    return [];
  }
}
