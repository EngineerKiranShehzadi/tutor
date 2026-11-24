// Relevance Grader agent (CRAG) — NEW.
//
// Judges whether the retrieved chunks are sufficient to answer the question.
// Its verdict drives the retrieve -> rewrite -> retrieve loop in the graph:
// INSUFFICIENT sends the question back to the rewriter (bounded by the graph
// config's retry cap).
//
// Design notes aligned with this repo:
//  - Structured output validated with zod; anything invalid is a provider
//    problem, not a "no evidence" signal.
//  - FAIL-OPEN: on any error (timeout, provider outage, invalid JSON) the
//    grader returns RELEVANT so an infrastructure blip can never silently
//    starve a good question — the downstream groundedness verifier still
//    guards answer quality. (Contrast the verifier, which fails CLOSED.)
//  - Call this at temperature 0 (pass a task config whose TEMPERATURE is 0)
//    so the same question+context yields the same verdict — reproducibility.
import { z } from 'zod';
import { resolveLlmProvider } from '../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../llm/llm-observability.service';
import { logger } from '../../../utils/logger';
import type { QnaChunk } from '../../../types';

export type RelevanceVerdict = 'RELEVANT' | 'INSUFFICIENT';

// The LLM-task config shape this agent needs. In production bind it to an
// existing judge-like task (e.g. env.LLM.ANSWER_VERIFICATION) so no new env
// is required; split into a dedicated GRADER task later if you want separate
// tuning.
export interface GraderTaskConfig {
  PROVIDER: string;
  MODEL: string;
  TIMEOUT_MS: number;
  TEMPERATURE: number;
}

const GRADER_SYSTEM_PROMPT =
  'You are a LENIENT retrieval grader for a lecture tutoring system. The excerpts ' +
  'you are given already passed a relevance filter, so your ONLY job is to catch ' +
  'the rare case where they are about a completely different topic and contain ' +
  'nothing that could help answer the question.\n' +
  'Return strict JSON: {"sufficient": boolean, "reason": string}.\n' +
  '- sufficient=true if the excerpts contain ANY information relevant to the ' +
  'question — even a single excerpt, even partial coverage. A partial answer is ' +
  'still worth generating; the answer step will say what is not covered.\n' +
  '- sufficient=false ONLY if the excerpts are clearly off-topic / about something ' +
  'else entirely.\n' +
  'When in doubt, sufficient=true. Do NOT require complete or multi-excerpt ' +
  'coverage.';

const GraderResponse = z.object({
  sufficient: z.boolean(),
  reason: z.string().optional().default(''),
});

function buildUserPrompt(question: string, documents: QnaChunk[]): string {
  const evidence = documents
    .map((d, i) => `[Excerpt ${i + 1}]\n${d.chunk_text}`)
    .join('\n\n');
  return `Student question:\n${question}\n\nRetrieved excerpts:\n${evidence || '(none)'}`;
}

export async function gradeRelevance(
  question: string,
  documents: QnaChunk[],
  cfg: GraderTaskConfig,
): Promise<RelevanceVerdict> {
  // No documents is trivially insufficient — but the graph already short-
  // circuits this case before calling us, so reaching here with none is rare.
  if (documents.length === 0) return 'INSUFFICIENT';

  try {
    const provider = resolveLlmProvider(cfg.PROVIDER);
    const result = await withLlmDiagnostic(
      {
        spanName: 'relevance_grader_call',
        operationType: 'RELEVANCE_GRADING',
        provider: provider.name,
        model: cfg.MODEL,
        invocationParams: { temperature: cfg.TEMPERATURE, timeoutMs: cfg.TIMEOUT_MS },
      },
      () => provider.generate({
        model: cfg.MODEL,
        systemPrompt: GRADER_SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(question, documents),
        temperature: cfg.TEMPERATURE,
        timeoutMs: cfg.TIMEOUT_MS,
      } as Parameters<typeof provider.generate>[0]),
      extractLlmUsage,
    );

    const parsed = GraderResponse.safeParse(JSON.parse((result as { raw: string }).raw));
    if (!parsed.success) {
      logger.warn('[RELEVANCE-GRADER] invalid structured output — failing open to RELEVANT');
      return 'RELEVANT';
    }
    return parsed.data.sufficient ? 'RELEVANT' : 'INSUFFICIENT';
  } catch (err) {
    logger.warn(`[RELEVANCE-GRADER] ⚠️ grading failed, failing open to RELEVANT: ${(err as Error).message}`);
    return 'RELEVANT';
  }
}
