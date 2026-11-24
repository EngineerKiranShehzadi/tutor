// HyDE — Hypothetical Document Embeddings — NEW, Phase 2.
//
// Instead of embedding only the (short, keyword-ish) question, HyDE asks the
// model to write a brief hypothetical answer and embeds THAT. A hypothetical
// answer sits closer in embedding space to the real lecture passages than a
// bare question does, which improves recall on under-specified queries.
//
//  - Returns plain text (the hypothetical passage), to be embedded by the
//    retrieve binding alongside the real query.
//  - FAIL-OPEN: on any error return '' so the caller simply skips HyDE and
//    falls back to the literal query. Never throws.
//  - Temperature 0 for reproducibility.
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { logger } from '../../../utils/logger';

export interface HydeTaskConfig {
  PROVIDER: string;
  MODEL: string;
  TIMEOUT_MS: number;
  TEMPERATURE: number;
}

const HYDE_SYSTEM_PROMPT =
  'You generate a short, plausible answer passage for a lecture question, as if ' +
  'written in the lecture notes. Keep it to 2-3 sentences. Do NOT hedge, do NOT ' +
  'say you are unsure, and do NOT add disclaimers — this text is only used to ' +
  'improve document retrieval, never shown to the student. Stay on the topic of ' +
  'the question.';

export async function generateHyde(question: string, cfg: HydeTaskConfig): Promise<string> {
  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await withLlmDiagnostic(
      {
        spanName: 'hyde_call',
        operationType: 'HYDE_GENERATION',
        provider: provider.name,
        model: cfg.MODEL,
        invocationParams: { temperature: cfg.TEMPERATURE, timeoutMs: cfg.TIMEOUT_MS },
      },
      () => provider.generate({
        model: cfg.MODEL,
        systemPrompt: HYDE_SYSTEM_PROMPT,
        userPrompt: `Question:\n${question}`,
        temperature: cfg.TEMPERATURE,
        timeoutMs: cfg.TIMEOUT_MS,
      } as Parameters<typeof provider.generate>[0]),
      extractLlmUsage,
    );

    return ((result as { raw: string }).raw || '').trim();
  } catch (err) {
    logger.warn(`[HYDE] ⚠️ generation failed, skipping HyDE: ${(err as Error).message}`);
    return '';
  }
}
