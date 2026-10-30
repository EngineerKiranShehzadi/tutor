import { env } from '../../../config/env';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { logger } from '../../../utils/logger';
import { ANSWER_REVISION_SYSTEM_PROMPT } from './answer-groundedness.prompt';
import type { RevisionOutcome } from './answer-verification.types';

// The writer to the verifier's judge — takes exactly what the verifier
// already identified as wrong and produces one corrected draft. Never
// decides on its own what's wrong, and never retries itself; bounding the
// overall verify -> revise -> verify loop is output-guardrail.service.ts's
// job, not this function's.
function buildRevisionUserPrompt(params: {
  question: string;
  evidenceTexts: string[];
  draftAnswer: string;
  unsupportedClaims: string[];
  uncoveredAspects: string[];
}): string {
  const evidenceBlock = params.evidenceTexts.length > 0
    ? params.evidenceTexts.map((text, i) => `[Evidence ${i + 1}]\n${text}`).join('\n\n')
    : '(no evidence was retrieved)';
  const unsupportedBlock = params.unsupportedClaims.length > 0
    ? params.unsupportedClaims.map(c => `- ${c}`).join('\n')
    : '(none listed)';
  const uncoveredBlock = params.uncoveredAspects.length > 0
    ? params.uncoveredAspects.map(a => `- ${a}`).join('\n')
    : '(none)';

  return `Question:\n${params.question}\n\nEvidence:\n${evidenceBlock}\n\nCurrent draft answer:\n${params.draftAnswer}\n\nUnsupported claims to remove or fix:\n${unsupportedBlock}\n\nAspects to NOT attempt to answer:\n${uncoveredBlock}`;
}

export interface ReviseAnswerParams {
  question: string;
  evidenceTexts: string[];
  draftAnswer: string;
  unsupportedClaims: string[];
  uncoveredAspects: string[];
}

// Entry point used by output-guardrail.service.ts. Never throws — a
// revision failure (timeout, provider error, empty output) is reported as
// a typed failure so the caller falls back to the existing conservative
// grounded response instead of ever returning an empty or clearly-broken
// answer to the student.
export async function reviseAnswer(params: ReviseAnswerParams): Promise<RevisionOutcome> {
  try {
    // Shares the verifier's provider/model config on purpose — revision is
    // part of the same output-guardrail loop, not a second independent
    // generation concern with its own config surface.
    const provider = resolveLlmProvider(env.LLM.ANSWER_VERIFICATION.PROVIDER);
    const model = env.LLM.ANSWER_VERIFICATION.MODEL;
    const timeoutMs = env.LLM.ANSWER_VERIFICATION.TIMEOUT_MS;

    const result = await withLlmDiagnostic(
      {
        spanName: 'answer_revision_call',
        operationType: 'ANSWER_REVISION',
        provider: provider.name,
        model,
        invocationParams: { temperature: 0.2, maxOutputTokens: 2048, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: buildRevisionUserPrompt(params),
        systemPrompt: ANSWER_REVISION_SYSTEM_PROMPT,
        temperature: 0.2,
        maxOutputTokens: 2048,
        thinking: env.LLM.ANSWER_VERIFICATION.THINKING,
        timeoutMs,
      }),
      extractLlmUsage
    );

    const revisedAnswer = result.raw?.trim();
    if (!revisedAnswer) {
      logger.warn('[ANSWER-VERIFICATION] ⚠️  Revision call returned an empty answer');
      return { ok: false, failureReason: 'REVISION_FAILED' };
    }
    return { ok: true, revisedAnswer };
  } catch (err) {
    logger.warn(`[ANSWER-VERIFICATION] ⚠️  Revision call failed: ${(err as Error).message}`);
    return { ok: false, failureReason: 'REVISION_FAILED' };
  }
}
