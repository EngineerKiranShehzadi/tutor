// Answer-Usefulness agent (Self-RAG) — NEW.
//
// Distinct from the groundedness verifier. Groundedness asks "is every claim
// supported by the evidence?"; usefulness asks "does this answer actually
// address what the student asked?". A draft can be perfectly grounded yet
// dodge the question (e.g. answers a neighbouring point). When usefulness
// fails, the graph routes to the reviser (bounded by the revise cap).
//
//  - Structured output validated with zod.
//  - FAIL-OPEN: on any error return useful=true, so an outage doesn't trap a
//    good answer in the revise loop. Quality still guarded by groundedness.
//  - Temperature 0 for reproducibility.
import { z } from 'zod';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { logger } from '../../../utils/logger';

export interface UsefulnessTaskConfig {
  PROVIDER: string;
  MODEL: string;
  TIMEOUT_MS: number;
  TEMPERATURE: number;
}

const USEFULNESS_SYSTEM_PROMPT =
  'You judge whether a tutor\'s answer actually addresses the student\'s question. ' +
  'Ignore whether it is factually correct — only judge RELEVANCE and COMPLETENESS ' +
  'relative to what was asked. Return strict JSON: {"useful": boolean, "reason": string}. ' +
  'Mark useful=false if the answer is off-topic, answers a different question, is empty, ' +
  'or leaves the core of the question unaddressed.';

const UsefulnessResponse = z.object({
  useful: z.boolean(),
  reason: z.string().optional().default(''),
});

export async function judgeUsefulness(
  question: string,
  draft: string,
  cfg: UsefulnessTaskConfig,
): Promise<boolean> {
  // An empty draft is never useful — no need to spend an LLM call.
  if (!draft.trim()) return false;

  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await provider.generate({
      model: cfg.MODEL,
      systemPrompt: USEFULNESS_SYSTEM_PROMPT,
      userPrompt: `Student question:\n${question}\n\nTutor answer:\n${draft}`,
      temperature: cfg.TEMPERATURE,
      timeoutMs: cfg.TIMEOUT_MS,
    } as Parameters<typeof provider.generate>[0]);

    const parsed = UsefulnessResponse.safeParse(JSON.parse((result as { raw: string }).raw));
    if (!parsed.success) {
      logger.warn('[ANSWER-USEFULNESS] invalid structured output — failing open to useful=true');
      return true;
    }
    return parsed.data.useful;
  } catch (err) {
    logger.warn(`[ANSWER-USEFULNESS] ⚠️ judging failed, failing open to useful=true: ${(err as Error).message}`);
    return true;
  }
}
