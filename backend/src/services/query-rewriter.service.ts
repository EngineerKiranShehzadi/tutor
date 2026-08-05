import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { getClient, type ConversationTurn } from './llm-gemini.service';
import { logger } from '../utils/logger';
import { withGeminiDiagnostic } from '../observability/gemini-diagnostics';

// Only rewrite when the latest question actually depends on prior context —
// avoids an extra Gemini round-trip on every single message.
const PRONOUN_REGEX = /\b(it|this|that|they|those|these|its|their)\b/i;

const FOLLOW_UP_PHRASES = [
  'what about',
  'why is that',
  'how does it',
  'explain it again',
  'explain that again',
  'another example',
  'the previous point',
  'the other one',
];

// Bare fragments ("Why?", "How so?") rarely carry enough meaning to stand
// alone as a retrieval query. Kept low (<=2 words) so it never fires on
// short-but-complete questions like "What is RAG?".
const VERY_SHORT_WORD_COUNT = 2;

export const isContextDependent = (question: string): boolean => {
  const trimmed = question.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (PRONOUN_REGEX.test(lower)) return true;
  if (FOLLOW_UP_PHRASES.some(phrase => lower.includes(phrase))) return true;

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount <= VERY_SHORT_WORD_COUNT;
};

const REWRITER_SYSTEM_PROMPT = `You are a query-rewriting component in a lecture-based RAG system.

Rewrite the student's latest question as one clear, concise, self-contained retrieval query using recent conversation history.

Rules:
- Use history only to resolve references such as it, this, that, they, the previous point, or the other one.
- Preserve the student's exact intent.
- Do not answer the question.
- Do not introduce new facts, assumptions, examples, or unrelated concepts.
- Do not broaden the topic.
- If the latest question is already self-contained, return it unchanged.
- Return only the required structured JSON.`;

const REWRITE_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    rewrittenQuery: { type: SchemaType.STRING },
    wasRewritten:   { type: SchemaType.BOOLEAN },
  },
  required: ['rewrittenQuery', 'wasRewritten'],
};

const DEFAULT_REWRITE_TIMEOUT_MS = 6000;
const MAX_HISTORY_TURNS = 4;

// Pure — safe to unit-test without hitting the network. Returns null for
// anything that isn't a usable, non-empty rewritten query.
export const parseRewriteResponse = (raw: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).rewrittenQuery !== 'string'
  ) {
    return null;
  }

  const rewritten = (parsed as { rewrittenQuery: string }).rewrittenQuery.trim();
  return rewritten.length > 0 ? rewritten : null;
};

const callGeminiRewriter = async (
  question: string,
  history: ConversationTurn[],
  timeoutMs: number
): Promise<string | null> => {
  try {
    const genAI = getClient();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: REWRITER_SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
        responseSchema: REWRITE_RESPONSE_SCHEMA,
      },
    });

    const historyBlock = history
      .map(t => `Student: ${t.question}\nAssistant: ${t.answer}`)
      .join('\n');

    const prompt = `Conversation history:\n${historyBlock}\n\nLatest question:\n${question}`;

    const result = await withGeminiDiagnostic(
      {
        spanName: 'gemini_rewriter_call',
        operationType: 'QUERY_REWRITE',
        model: 'gemini-2.5-flash',
        invocationParams: { temperature: 0, maxOutputTokens: 256, timeoutMs },
      },
      () => model.generateContent(prompt, { timeout: timeoutMs }),
      r => ({
        input: r.response.usageMetadata?.promptTokenCount,
        output: r.response.usageMetadata?.candidatesTokenCount,
        finishReason: r.response.candidates?.[0]?.finishReason,
      })
    );
    return parseRewriteResponse(result.response.text());
  } catch (err) {
    logger.warn(`[QUERY-REWRITE] ⚠️  Rewrite call failed, falling back to original question: ${(err as Error).message}`);
    return null;
  }
};

export interface RetrievalQueryResult {
  query: string;
  wasRewritten: boolean;
  // True iff a Gemini rewrite call was actually made — false when skipped
  // because the question was already self-contained or no history existed
  // yet. Distinct from wasRewritten: a call can be attempted and still
  // fall back to the original question (timeout, invalid output, etc.).
  attempted: boolean;
}

// Entry point used by chat.service.ts. Never throws — any failure (network,
// timeout, malformed/empty response) falls back to the original question so
// a rewrite problem can never break the chat request.
export const resolveRetrievalQuery = async (
  question: string,
  history: ConversationTurn[],
  opts: {
    timeoutMs?: number;
    // Test-only seam: overrides the Gemini call itself so unit tests never
    // hit the network/quota. Production always falls through to the real
    // callGeminiRewriter. Live semantic-quality tests (does it *correctly*
    // resolve "it" to the right referent?) live in a separate :live suite
    // that intentionally omits this override.
    geminiCaller?: typeof callGeminiRewriter;
  } = {}
): Promise<RetrievalQueryResult> => {
  try {
    if (!isContextDependent(question)) {
      return { query: question, wasRewritten: false, attempted: false };
    }

    const recentHistory = history.slice(-MAX_HISTORY_TURNS);
    if (recentHistory.length === 0) {
      // Nothing to resolve references against on the first turn of a session.
      return { query: question, wasRewritten: false, attempted: false };
    }

    const geminiCaller = opts.geminiCaller ?? callGeminiRewriter;
    const rewritten = await geminiCaller(question, recentHistory, opts.timeoutMs ?? DEFAULT_REWRITE_TIMEOUT_MS);
    if (!rewritten) {
      return { query: question, wasRewritten: false, attempted: true };
    }

    logger.info(`[QUERY-REWRITE] ✏️  "${question.slice(0, 60)}" -> "${rewritten.slice(0, 80)}"`);
    return { query: rewritten, wasRewritten: true, attempted: true };
  } catch (err) {
    logger.warn(`[QUERY-REWRITE] ⚠️  Unexpected error resolving retrieval query, falling back: ${(err as Error).message}`);
    return { query: question, wasRewritten: false, attempted: false };
  }
};
