import { env } from '../../../config/env';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { classifyErrorCode } from '../../../observability/tracer';
import { logger } from '../../../utils/logger';
import { logSafeText } from '../../../observability/sanitize';
import { detectCompoundQueryCandidate } from './compound-query.detector';
import { buildDecompositionSystemPrompt, DECOMPOSITION_RESPONSE_SCHEMA } from './subquery-decomposition.prompt';
import type { RawDecompositionDecision, SubqueryDecompositionResult } from './subquery-decomposition.types';

// Pure — safe to unit-test without hitting the network. Trims, drops
// empties, drops paraphrase-only duplicates (case/whitespace-insensitive),
// and enforces the configured max fan-out. Returns null (not an empty
// array) when nothing usable survives, so callers can tell "validated to
// zero subqueries" apart from "list was fine".
export function validateSubqueries(raw: unknown, maxSubqueries: number): string[] | null {
  if (!Array.isArray(raw)) return null;

  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
    if (cleaned.length >= maxSubqueries) break;
  }
  return cleaned.length > 0 ? cleaned : null;
}

// Pure — safe to unit-test without hitting the network. A DECOMPOSE
// decision needs at least 2 validated subqueries to actually mean anything
// (one subquery is just the original query with extra steps).
export function parseDecompositionResponse(raw: string, maxSubqueries: number): RawDecompositionDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';

  if (obj.decision === 'DIRECT') {
    return { decision: 'DIRECT', subqueries: [], reason };
  }
  if (obj.decision !== 'DECOMPOSE') return null;

  const subqueries = validateSubqueries(obj.subqueries, maxSubqueries);
  if (!subqueries || subqueries.length < 2) return null;
  return { decision: 'DECOMPOSE', subqueries, reason };
}

const callDecompositionLlm = async (effectiveQuery: string): Promise<RawDecompositionDecision | null> => {
  const provider = resolveLlmProvider(env.LLM.QUERY_DECOMPOSITION.PROVIDER);
  const model = env.LLM.QUERY_DECOMPOSITION.MODEL;
  const timeoutMs = env.LLM.QUERY_DECOMPOSITION.TIMEOUT_MS;
  const maxSubqueries = env.QUERY_DECOMPOSITION.MAX_SUBQUERIES;

  const result = await withLlmDiagnostic(
    {
      spanName: 'subquery_decomposition_call',
      operationType: 'QUERY_DECOMPOSITION',
      provider: provider.name,
      model,
      invocationParams: { temperature: env.LLM.QUERY_DECOMPOSITION.TEMPERATURE, maxOutputTokens: 400, timeoutMs },
    },
    () => provider.generate({
      model,
      userPrompt: `Student question:\n"""${effectiveQuery}"""`,
      systemPrompt: buildDecompositionSystemPrompt(maxSubqueries),
      temperature: env.LLM.QUERY_DECOMPOSITION.TEMPERATURE,
      maxOutputTokens: 400,
      thinking: env.LLM.QUERY_DECOMPOSITION.THINKING,
      responseSchema: DECOMPOSITION_RESPONSE_SCHEMA,
      timeoutMs,
    }),
    extractLlmUsage
  );

  return parseDecompositionResponse(result.raw, maxSubqueries);
};

// Entry point used by chat.service.ts, called once on the effective
// self-contained query (the rewritten query for CONTEXTUAL_FOLLOW_UP, the
// original question for FACT_QUESTION — never a raw history-dependent
// query; that's the existing rewriter's job, not this one's).
//
// Never throws. Any failure (disabled, not a candidate, LLM timeout/error,
// malformed/invalid structured output) falls back to DIRECT with
// effectiveQuery unchanged, so a decomposition problem can never break the
// chat request — matches query-router.service.ts / query-rewriter.
// service.ts's existing fail-safe philosophy.
export const decomposeQuery = async (
  effectiveQuery: string,
  opts: {
    // Test-only seam, same rationale as query-router.service.ts's
    // llmClassifier / query-rewriter.service.ts's llmCaller.
    decompositionCaller?: typeof callDecompositionLlm;
  } = {}
): Promise<SubqueryDecompositionResult> => {
  if (!env.QUERY_DECOMPOSITION.ENABLED) {
    return { mode: 'DIRECT', effectiveQuery, subqueries: [], reason: 'DECOMPOSITION_DISABLED', llmUsed: false };
  }

  const { isCandidate } = detectCompoundQueryCandidate(effectiveQuery);
  if (!isCandidate) {
    return { mode: 'DIRECT', effectiveQuery, subqueries: [], reason: 'NOT_COMPOUND', llmUsed: false };
  }

  try {
    const caller = opts.decompositionCaller ?? callDecompositionLlm;
    const decision = await caller(effectiveQuery);

    if (!decision) {
      logger.warn('[QUERY-DECOMPOSITION] ⚠️  Unparseable/invalid decomposition output — falling back to DIRECT');
      return { mode: 'DIRECT', effectiveQuery, subqueries: [], reason: 'INVALID_SUBQUERY_LIST', llmUsed: true };
    }
    if (decision.decision === 'DIRECT') {
      return { mode: 'DIRECT', effectiveQuery, subqueries: [], reason: 'LLM_DECIDED_DIRECT', llmUsed: true };
    }

    logger.info(`[QUERY-DECOMPOSITION] 🔀 "${logSafeText(effectiveQuery, 60)}" -> ${decision.subqueries.length} subqueries`);
    return { mode: 'DECOMPOSED', effectiveQuery, subqueries: decision.subqueries, reason: 'LLM_DECIDED_DECOMPOSE', llmUsed: true };
  } catch (err) {
    const errorCode = classifyErrorCode(err);
    const reason = errorCode === 'TIMEOUT' ? 'CLASSIFIER_TIMEOUT' : 'CLASSIFIER_ERROR';
    logger.warn(`[QUERY-DECOMPOSITION] ⚠️  Decomposition call failed (${reason}), falling back to DIRECT: ${(err as Error).message}`);
    return { mode: 'DIRECT', effectiveQuery, subqueries: [], reason, llmUsed: true };
  }
};
