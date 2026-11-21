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
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
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
  'You gate ONE thing: can this student message be turned into a search query on ' +
  'its own? Mark clear=false ONLY when the message points to something unspecified ' +
  'that the recent conversation does NOT resolve — a dangling reference such as ' +
  '"explain that", "tell me more", "what about the second one", "and the other?". ' +
  'In every other case mark clear=true.\n\n' +
  'CRITICAL RULES:\n' +
  '- Do NOT judge whether the question relates to the lecture. Relevance is decided ' +
  'later by retrieval, never here. A specific, self-contained question (it names a ' +
  'concrete topic, person, term, or task) is ALWAYS clear=true, EVEN IF the topic ' +
  'seems unrelated to the lecture — let retrieval return "not found" for those.\n' +
  '- NEVER ask whether the student means something "covered in the lecture". That is ' +
  'not a real ambiguity.\n' +
  '- If you (the tutor) already asked a clarifying question earlier and the student ' +
  'has now named any concrete topic, it is clear=true — do not ask again.\n' +
  '- When in doubt, clear=true.\n\n' +
  'Return strict JSON: {"clear": boolean, "clarification": string}. If clear=true, ' +
  'clarification MUST be an empty string. If clear=false, clarification MUST be ONE ' +
  'short question that resolves the dangling reference.';

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
    const result = await withLlmDiagnostic(
      {
        spanName: 'clarity_assessor_call',
        operationType: 'CLARITY_ASSESSMENT',
        provider: provider.name,
        model: cfg.MODEL,
        invocationParams: { temperature: cfg.TEMPERATURE, timeoutMs: cfg.TIMEOUT_MS },
      },
      () => provider.generate({
        model: cfg.MODEL,
        systemPrompt: CLARITY_SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(question, history),
        temperature: cfg.TEMPERATURE,
        timeoutMs: cfg.TIMEOUT_MS,
      } as Parameters<typeof provider.generate>[0]),
      extractLlmUsage,
    );

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
