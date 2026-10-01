import { env } from '../../../config/env';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { classifyErrorCode } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { buildAdaptiveRetrievalSystemPrompt, ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA } from './adaptive-retrieval.prompt';
import type { AdaptivePlannerOutcome, AdaptiveRetrievalPlan } from './adaptive-retrieval.types';

// Pure — safe to unit-test without hitting the network. A RETRIEVE decision
// with no actual retrievalQuery is malformed (nothing to retrieve), so it's
// treated the same as unparseable output — both surface as INVALID_PLAN to
// the caller.
export function parseAdaptiveRetrievalPlan(raw: string): AdaptiveRetrievalPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';

  if (obj.action === 'STOP') {
    return { action: 'STOP', reason };
  }
  if (obj.action !== 'RETRIEVE') return null;

  const retrievalQuery = typeof obj.retrievalQuery === 'string' ? obj.retrievalQuery.trim() : '';
  const targetAspect = typeof obj.targetAspect === 'string' ? obj.targetAspect.trim() : '';
  if (!retrievalQuery) return null;

  return { action: 'RETRIEVE', retrievalQuery, targetAspect: targetAspect || undefined, reason };
}

function buildUserPrompt(params: { effectiveQuery: string; uncoveredAspects: string[]; attemptedQueries: string[] }): string {
  const sections = [
    `Original/effective question:\n"""${params.effectiveQuery}"""`,
    `Uncovered aspect(s) — no supporting lecture evidence found yet:\n${params.uncoveredAspects.map(a => `- ${a}`).join('\n')}`,
  ];
  sections.push(
    params.attemptedQueries.length > 0
      ? `Retrieval queries already attempted — never repeat or closely paraphrase these:\n${params.attemptedQueries.map(q => `- ${q}`).join('\n')}`
      : 'No retrieval queries have been attempted yet.'
  );
  return sections.join('\n\n');
}

// Entry point used by adaptive-retrieval.service.ts. Never throws — any
// failure (timeout, provider error, malformed/invalid structured output)
// is reported as a typed failure so the caller can stop adaptive retrieval
// and fall back to existing grounded generation, exactly like every other
// LLM call site in this codebase.
export async function planAdaptiveRetrieval(params: {
  effectiveQuery: string;
  uncoveredAspects: string[];
  attemptedQueries: string[];
}): Promise<AdaptivePlannerOutcome> {
  try {
    const provider = resolveLlmProvider(env.LLM.ADAPTIVE_RETRIEVAL.PROVIDER);
    const model = env.LLM.ADAPTIVE_RETRIEVAL.MODEL;
    const timeoutMs = env.LLM.ADAPTIVE_RETRIEVAL.TIMEOUT_MS;

    const result = await withLlmDiagnostic(
      {
        spanName: 'adaptive_retrieval_planner_call',
        operationType: 'ADAPTIVE_RETRIEVAL_PLANNING',
        provider: provider.name,
        model,
        invocationParams: { temperature: env.LLM.ADAPTIVE_RETRIEVAL.TEMPERATURE, maxOutputTokens: 300, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: buildUserPrompt(params),
        systemPrompt: buildAdaptiveRetrievalSystemPrompt(),
        temperature: env.LLM.ADAPTIVE_RETRIEVAL.TEMPERATURE,
        maxOutputTokens: 300,
        responseSchema: ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA,
        timeoutMs,
      }),
      extractLlmUsage
    );

    const plan = parseAdaptiveRetrievalPlan(result.raw);
    if (!plan) {
      logger.warn('[ADAPTIVE-RETRIEVAL] ⚠️  Planner returned unparseable/invalid plan');
      return { ok: false, failureReason: 'INVALID_PLAN' };
    }
    return { ok: true, plan };
  } catch (err) {
    const errorCode = classifyErrorCode(err);
    const failureReason = errorCode === 'TIMEOUT' ? 'PLANNER_TIMEOUT' : 'PLANNER_ERROR';
    logger.warn(`[ADAPTIVE-RETRIEVAL] ⚠️  Planner call failed (${failureReason}): ${(err as Error).message}`);
    return { ok: false, failureReason };
  }
}
