// Clarity Assessor agent (Clarification) — NEW, Phase 2.
//
// Decides whether a student's question is specific enough to retrieve for. If
// not, it returns ONE clarifying question to ask back — the graph then answers
// with that instead of guessing. This is a tutor-specific value-add: guessing
// at an ambiguous question wastes a turn and can mislead a learner.
//
//  - Structured output validated with zod.
//  - FAIL-OPEN: on any error, clear=true (proceed to retrieval). A clarity
//    outage must never block an answerable question.
//  - Temperature 0 for reproducibility.
//  - Bounded by construction: clarification happens at most once per turn (the
//    student's reply arrives as a fresh invocation), so there is no loop.
import { z } from 'zod';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { logger } from '../../../utils/logger';
import type { ConversationTurn } from '../../../services/answer-generation.service';

export interface ClarityTaskConfig {
  PROVIDER: string;
  MODEL: string;
  TIMEOUT_MS: number;
  TEMPERATURE: number;
}

export interface ClarityResult {
  clear: boolean;
  clarification: string;
}

const CLARITY_SYSTEM_PROMPT =
  'You decide whether a student question to a lecture tutor is specific enough to ' +
  'answer from the lecture, or too vague/ambiguous to retrieve for. Consider the ' +
  'recent conversation for context. Return strict JSON: ' +
  '{"clear": boolean, "clarification": string}. If clear=true, clarification MUST ' +
  'be an empty string. If clear=false, clarification MUST be ONE short, friendly ' +
  'question that would let you retrieve the right material. Prefer clear=true; only ' +
  'ask when genuinely necessary (e.g. "explain that" with no referent, or a term ' +
  'that could mean several different things in this lecture).';

const ClarityResponse = z.object({
  clear: z.boolean(),
  clarification: z.string().optional().default(''),
});

function buildUserPrompt(question: string, history: ConversationTurn[]): string {
  const recent = history.slice(-4);
  const historyBlock = recent.length
    ? `Recent conversation:\n${recent.map(t => `Student: ${t.question}\nTutor: ${t.answer}`).join('\n')}\n\n`
    : '';
  return `${historyBlock}Current student question:\n${question}`;
}

export async function assessClarity(
  question: string,
  history: ConversationTurn[],
  cfg: ClarityTaskConfig,
): Promise<ClarityResult> {
  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await provider.generate({
      model: cfg.MODEL,
      systemPrompt: CLARITY_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(question, history),
      temperature: cfg.TEMPERATURE,
      timeoutMs: cfg.TIMEOUT_MS,
    } as Parameters<typeof provider.generate>[0]);

    const parsed = ClarityResponse.safeParse(JSON.parse((result as { raw: string }).raw));
    if (!parsed.success) {
      logger.warn('[CLARITY-ASSESSOR] invalid structured output — failing open to clear=true');
      return { clear: true, clarification: '' };
    }
    // A non-clear verdict with no question is useless — treat as clear.
    if (!parsed.data.clear && !parsed.data.clarification.trim()) {
      return { clear: true, clarification: '' };
    }
    return { clear: parsed.data.clear, clarification: parsed.data.clarification };
  } catch (err) {
    logger.warn(`[CLARITY-ASSESSOR] ⚠️ assessment failed, failing open to clear=true: ${(err as Error).message}`);
    return { clear: true, clarification: '' };
  }
}
