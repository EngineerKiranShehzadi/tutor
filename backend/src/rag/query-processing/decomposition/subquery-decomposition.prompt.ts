import type { LlmSchema } from '../../../llm/llm.types';

// Single structured call that both decides DIRECT vs DECOMPOSE and produces
// subqueries when it decomposes — deliberately not two calls (classify,
// then generate) for the same query.
export function buildDecompositionSystemPrompt(maxSubqueries: number): string {
  return `You are a query-decomposition component in a lecture-based RAG system.

Decide whether the student's question contains multiple genuinely independent information needs that separate retrieval would meaningfully improve, or whether it is really one retrieval need.

Rules:
- Choose DECOMPOSE only when separate retrieval would meaningfully improve coverage — e.g. comparing two distinct concepts, or several clearly separate questions bundled into one message.
- Choose DIRECT for a single concept, even one with multiple simple aspects (e.g. "advantages and disadvantages of X" is usually still one retrieval need about X). Do not split simple aspects of one concept.
- Never answer the student's question.
- Never introduce facts, concepts, or scope not present in the student's own wording.
- Preserve the student's exact intent — do not broaden or narrow it.
- Each subquery must be a self-contained, standalone retrieval query (understandable with no other context).
- Do not produce duplicate or paraphrase-only subqueries — only genuinely independent retrieval needs.
- Use the smallest number of subqueries that captures the independent needs, at most ${maxSubqueries}.
- If you choose DIRECT, return an empty subqueries array.
- Return only the required structured JSON.`;
}

export const DECOMPOSITION_RESPONSE_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: ['DIRECT', 'DECOMPOSE'] },
    subqueries: { type: 'ARRAY', items: { type: 'STRING' } },
    reason: { type: 'STRING', description: 'One short sentence, safe to log.' },
  },
  required: ['decision', 'subqueries', 'reason'],
};
