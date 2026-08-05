import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { getClient } from './llm-gemini.service';
import { isContextDependent } from './query-rewriter.service';
import { logger } from '../utils/logger';
import { withGeminiDiagnostic } from '../observability/gemini-diagnostics';

export type LectureQueryRoute =
  | 'FACT_QUESTION'
  | 'LECTURE_SUMMARY'
  | 'CONTEXTUAL_FOLLOW_UP'
  | 'GREETING';

const ROUTES: LectureQueryRoute[] = ['FACT_QUESTION', 'LECTURE_SUMMARY', 'CONTEXTUAL_FOLLOW_UP', 'GREETING'];

export interface RouteClassification {
  route: LectureQueryRoute;
  // Where the decision came from — for logging/observability only.
  source: 'rule' | 'llm' | 'llm-fallback';
}

// ── Deterministic rules — obvious cases never touch Gemini ────────────────

const GREETING_PATTERNS = [
  /^(hi|hello|hey|hiya|yo|greetings)[\s,!.]*$/i,
  /^good\s+(morning|afternoon|evening)[\s!.]*$/i,
  /^how\s+are\s+you(\s+doing)?\??$/i,
  /^what'?s\s+up\??$/i,
];

const isGreeting = (trimmed: string): boolean =>
  GREETING_PATTERNS.some(re => re.test(trimmed));

const isLectureSummaryRequest = (trimmed: string): boolean => {
  const lower = trimmed.toLowerCase();
  if (/\bsummar(y|ize|ise|izing|ising|ies)\b/.test(lower) && /\blecture\b|\bthis\b|\bit\b/.test(lower)) return true;
  if (lower.includes('key points')) return true;
  if (/\bmain\s+topics\b/.test(lower)) return true;
  if (/\boverview\b/.test(lower) && /\blecture\b/.test(lower)) return true;
  return false;
};

// A message "reads as" a well-formed question/request when it ends with '?'
// or opens with a common question/imperative word. Anything that reaches
// here without matching that AND without matching any rule above is what we
// treat as genuinely ambiguous — everything else (the vast majority of real
// questions) defaults straight to FACT_QUESTION with no LLM call at all.
const QUESTION_LIKE_OPENERS = /^(what|why|how|when|where|who|which|explain|describe|define|give|list|can|could|does|do|is|are|tell|summarize|summarise)\b/i;

const looksLikeWellFormedRequest = (trimmed: string): boolean =>
  /\?\s*$/.test(trimmed) || QUESTION_LIKE_OPENERS.test(trimmed);

const classifyByRule = (question: string): LectureQueryRoute | null => {
  const trimmed = question.trim();
  if (!trimmed) return 'FACT_QUESTION';

  if (isGreeting(trimmed)) return 'GREETING';
  if (isLectureSummaryRequest(trimmed)) return 'LECTURE_SUMMARY';
  if (isContextDependent(trimmed)) return 'CONTEXTUAL_FOLLOW_UP';
  if (looksLikeWellFormedRequest(trimmed)) return 'FACT_QUESTION';

  return null; // genuinely ambiguous — worth a small LLM classification call
};

// ── LLM fallback for genuinely ambiguous input ─────────────────────────────

const ROUTER_SYSTEM_PROMPT = `You are a request router for a lecture-based AI tutor.

Classify the student's latest message into exactly one route:
- GREETING: a greeting or small talk with no lecture question in it.
- LECTURE_SUMMARY: asks for a summary, overview, or key points of the whole lecture.
- CONTEXTUAL_FOLLOW_UP: only makes sense combined with the immediately preceding conversation (uses "it", "that", "this", "the previous point", etc.).
- FACT_QUESTION: any other question about the lecture's content.

Rules:
- Do not answer the message.
- Do not decide whether the lecture actually contains the answer — that is decided later by retrieval.
- If unsure, choose FACT_QUESTION.
- Return only the required structured JSON.`;

const ROUTE_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    route: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ROUTES,
    },
  },
  required: ['route'],
};

const DEFAULT_ROUTER_TIMEOUT_MS = 5000;

// Pure — safe to unit-test without hitting the network.
export const parseRouteResponse = (raw: string): LectureQueryRoute | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const route = (parsed as Record<string, unknown>).route;
  if (typeof route !== 'string' || !ROUTES.includes(route as LectureQueryRoute)) return null;

  return route as LectureQueryRoute;
};

const classifyWithGemini = async (question: string, timeoutMs: number): Promise<LectureQueryRoute | null> => {
  try {
    const genAI = getClient();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: ROUTER_SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        responseMimeType: 'application/json',
        responseSchema: ROUTE_RESPONSE_SCHEMA,
      },
    });

    const result = await withGeminiDiagnostic(
      {
        spanName: 'gemini_router_call',
        operationType: 'ROUTE_CLASSIFICATION',
        model: 'gemini-2.5-flash',
        invocationParams: { temperature: 0, maxOutputTokens: 64, timeoutMs },
      },
      () => model.generateContent(`Student message:\n${question}`, { timeout: timeoutMs }),
      r => ({
        input: r.response.usageMetadata?.promptTokenCount,
        output: r.response.usageMetadata?.candidatesTokenCount,
        finishReason: r.response.candidates?.[0]?.finishReason,
      })
    );
    return parseRouteResponse(result.response.text());
  } catch (err) {
    logger.warn(`[QUERY-ROUTER] ⚠️  LLM classification failed, defaulting to FACT_QUESTION: ${(err as Error).message}`);
    return null;
  }
};

// Entry point used by chat.service.ts. Never throws — any failure (network,
// timeout, malformed output) safely defaults to FACT_QUESTION so a routing
// problem can never break the chat request.
export const classifyRoute = async (
  question: string,
  opts: {
    timeoutMs?: number;
    // Test-only seam, same rationale as query-rewriter.service.ts's
    // geminiCaller: keeps the deterministic test suite network/quota-free.
    geminiClassifier?: typeof classifyWithGemini;
  } = {}
): Promise<RouteClassification> => {
  try {
    const ruleMatch = classifyByRule(question);
    if (ruleMatch) {
      return { route: ruleMatch, source: 'rule' };
    }

    const classifier = opts.geminiClassifier ?? classifyWithGemini;
    const llmRoute = await classifier(question, opts.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS);
    if (llmRoute) {
      return { route: llmRoute, source: 'llm' };
    }

    return { route: 'FACT_QUESTION', source: 'llm-fallback' };
  } catch (err) {
    logger.warn(`[QUERY-ROUTER] ⚠️  Unexpected error classifying route, defaulting to FACT_QUESTION: ${(err as Error).message}`);
    return { route: 'FACT_QUESTION', source: 'llm-fallback' };
  }
};
