import type { LlmSchema } from '../../../llm/llm.types';

// Strictly a planning prompt — the model never answers the student's
// question here, it only decides whether one more targeted retrieval
// attempt is worth making for a SPECIFIC, already-identified missing
// aspect (never a new subtopic the student didn't ask about).
export function buildAdaptiveRetrievalSystemPrompt(): string {
  return `You are a retrieval-planning component in a lecture-based RAG system. You do not answer questions — you only decide whether one more targeted retrieval attempt is worth making, and if so, produce the exact retrieval query to use.

Context: the student's original/effective question was already processed and retrieval already ran. Some of the information needs it requires still have NO supporting evidence from the lecture ("uncovered aspects" below). Your job is to decide whether one more focused retrieval could find that missing evidence.

Rules:
- Only ever target information needs already implied by the student's original/effective question — never introduce a new subtopic, and never broaden the request.
- If more than one aspect is listed as uncovered, choose exactly ONE to target this attempt — the one most central to the original question.
- Echo the chosen aspect back exactly (or as close to exactly as possible) in "targetAspect" so it can be matched to the original request.
- The retrieval query must be self-contained and focused ONLY on that one missing aspect — do not restate the whole original question.
- Never propose a retrieval query that repeats or closely paraphrases any query already listed under "already attempted".
- Never answer the student's question.
- Never add facts, examples, or claims not implied by the student's own wording.
- Return STOP if no meaningful, non-duplicate targeted retrieval query can be formed — do not fabricate an exploratory query just to have something to return.
- Return only the required structured JSON.`;
}

export const ADAPTIVE_RETRIEVAL_RESPONSE_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ['STOP', 'RETRIEVE'] },
    retrievalQuery: { type: 'STRING', description: 'Required when action is RETRIEVE; a focused, self-contained retrieval query.' },
    targetAspect: { type: 'STRING', description: 'Required when action is RETRIEVE; the uncovered aspect this query targets, echoed back.' },
    reason: { type: 'STRING', description: 'One short sentence, safe to log.' },
  },
  required: ['action', 'reason'],
};
