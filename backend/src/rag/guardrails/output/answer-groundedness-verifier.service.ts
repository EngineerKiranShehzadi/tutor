import { env } from '../../../config/env';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { classifyErrorCode } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { buildGroundednessSystemPrompt, GROUNDEDNESS_RESPONSE_SCHEMA } from './answer-groundedness.prompt';
import type { AnswerVerificationReason, AnswerVerificationResult, VerifierOutcome } from './answer-verification.types';

const MAX_LIST_ITEMS = 5;
const MAX_ITEM_LENGTH = 300;
const MAX_DETAIL_LENGTH = 400;

function clampList(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    .slice(0, MAX_LIST_ITEMS)
    .map(i => i.trim().slice(0, MAX_ITEM_LENGTH));
}

// Derives the stable reason code from the decision plus which list the
// verifier actually populated — a deterministic mapping, not a guess: the
// model is instructed to fill missingAspects specifically when the draft
// touches an uncovered aspect, so a non-empty list there is a strong,
// direct signal (not inferred from claim text).
function deriveReason(decision: AnswerVerificationResult['decision'], missingAspects: string[]): AnswerVerificationReason {
  if (decision === 'VERIFIED') return 'VERIFIED';
  if (decision === 'INSUFFICIENT_EVIDENCE') return 'INSUFFICIENT_EVIDENCE';
  return missingAspects.length > 0 ? 'ANSWERED_UNCOVERED_ASPECT' : 'UNSUPPORTED_CLAIMS';
}

// Pure — safe to unit-test without hitting the network.
export function parseGroundednessResponse(raw: string): AnswerVerificationResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision;
  if (decision !== 'VERIFIED' && decision !== 'REVISE' && decision !== 'INSUFFICIENT_EVIDENCE') return null;

  const unsupportedClaims = clampList(obj.unsupportedClaims);
  const missingAspects = clampList(obj.missingAspects);
  const detail = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, MAX_DETAIL_LENGTH) : '';

  return { decision, unsupportedClaims, missingAspects, reason: deriveReason(decision, missingAspects), detail };
}

function buildVerifierUserPrompt(params: {
  question: string;
  uncoveredAspects: string[];
  evidenceTexts: string[];
  draftAnswer: string;
}): string {
  const evidenceBlock = params.evidenceTexts.length > 0
    ? params.evidenceTexts.map((text, i) => `[Evidence ${i + 1}]\n${text}`).join('\n\n')
    : '(no evidence was retrieved)';
  const uncoveredBlock = params.uncoveredAspects.length > 0
    ? params.uncoveredAspects.map(a => `- ${a}`).join('\n')
    : '(none)';

  return `Question:\n${params.question}\n\nKnown unsupported aspects (must NOT be answered from the evidence):\n${uncoveredBlock}\n\nEvidence:\n${evidenceBlock}\n\nDraft answer:\n${params.draftAnswer}`;
}

export interface VerifyAnswerParams {
  question: string;
  uncoveredAspects: string[];
  // Clean text only — the same chunk_text actually supplied to the
  // generator, never raw QnaChunk rows (no ids, timestamps, or other
  // internal fields reach the verifier prompt).
  evidenceTexts: string[];
  draftAnswer: string;
}

// Entry point used by output-guardrail.service.ts. Never throws — any
// failure (timeout, provider error, malformed/invalid structured output)
// is reported as a typed failure so the caller can fall back conservatively
// instead of ever silently treating a failure as VERIFIED.
export async function verifyAnswerGroundedness(params: VerifyAnswerParams): Promise<VerifierOutcome> {
  // One bounded retry: every failure mode here (timeout, provider hiccup,
  // truncated/invalid JSON) is transient, and a single blip must not decide
  // the fate of an otherwise good draft.
  const first = await verifyOnce(params);
  if (first.ok) return first;
  logger.warn(`[ANSWER-VERIFICATION] ⚠️  ${first.failureReason} — retrying once`);
  await new Promise(res => setTimeout(res, 400));
  return verifyOnce(params);
}

async function verifyOnce(params: VerifyAnswerParams): Promise<VerifierOutcome> {
  try {
    const provider = resolveLlmProvider(env.LLM.ANSWER_VERIFICATION.PROVIDER);
    const model = env.LLM.ANSWER_VERIFICATION.MODEL;
    const timeoutMs = env.LLM.ANSWER_VERIFICATION.TIMEOUT_MS;

    const result = await withLlmDiagnostic(
      {
        spanName: 'answer_groundedness_verifier_call',
        operationType: 'ANSWER_VERIFICATION',
        provider: provider.name,
        model,
        invocationParams: { temperature: env.LLM.ANSWER_VERIFICATION.TEMPERATURE, maxOutputTokens: env.LLM.ANSWER_VERIFICATION.MAX_OUTPUT_TOKENS, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: buildVerifierUserPrompt(params),
        systemPrompt: buildGroundednessSystemPrompt(),
        temperature: env.LLM.ANSWER_VERIFICATION.TEMPERATURE,
        maxOutputTokens: env.LLM.ANSWER_VERIFICATION.MAX_OUTPUT_TOKENS,
        // The verdict is a small JSON object; with thinking on, Gemini can
        // spend the whole output cap thinking and return truncated JSON.
        thinking: env.LLM.ANSWER_VERIFICATION.THINKING,
        responseSchema: GROUNDEDNESS_RESPONSE_SCHEMA,
        timeoutMs,
      }),
      extractLlmUsage
    );

    const parsedResult = parseGroundednessResponse(result.raw);
    if (!parsedResult) {
      logger.warn('[ANSWER-VERIFICATION] ⚠️  Verifier returned unparseable/invalid output');
      return { ok: false, failureReason: 'VERIFIER_INVALID_OUTPUT' };
    }
    return { ok: true, result: parsedResult };
  } catch (err) {
    const errorCode = classifyErrorCode(err);
    const failureReason = errorCode === 'TIMEOUT' ? 'VERIFIER_TIMEOUT' : 'VERIFIER_PROVIDER_ERROR';
    logger.warn(`[ANSWER-VERIFICATION] ⚠️  Verifier call failed (${failureReason}): ${(err as Error).message}`);
    return { ok: false, failureReason };
  }
}
