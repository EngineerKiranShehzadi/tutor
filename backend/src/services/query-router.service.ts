import { env } from '../config/env';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../llm/llm-observability.service';
import type { LlmSchema } from '../llm/llm.types';
import { isContextDependent } from './query-rewriter.service';
import { logger } from '../utils/logger';
import { FORMAT_REQUEST_WORDS } from '../rag/guardrails/output/format/response-format.detector';

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

// ── Deterministic rules — obvious cases never touch the LLM ────────────────

// Small-talk fragments. A message is a GREETING only when it is made up
// entirely of these (joined by "and"/commas/punctuation) — so "hi how are
// you" and "hi whats going on?" match, but "hi, what is RAG?" does not.
const SMALL_TALK_FRAGMENTS = [
  /(hi+|hello+|hey+|hiya|yo|greetings|howdy|sup)/,
  /good\s+(morning|afternoon|evening|day)/,
  /how\s+(are|r)\s+(you|u|ya)(\s+(doing|today|now))?/,
  /how\s+(is|are)\s+(it\s+going|everything|things|you\s+doing)(\s+today)?/,
  /how'?s\s+(it\s+going|everything|things|life|your\s+day)/,
  /how\s+do\s+you\s+do/,
  /what'?s\s+(up|going\s+on|new|happening)/,
  /whats\s+(up|going\s+on|new|happening)/,
  /what\s+is\s+(up|going\s+on)/,
  /nice\s+to\s+meet\s+you/,
  /(there|everyone|tutor|buddy|friend)/,
];

// Polite request wrappers ("tell me", "can you say", "please") only count
// as filler — a message still needs a real small-talk fragment to be a
// greeting, so "tell me about RAG" never qualifies.
const SMALL_TALK_FILLER = /^(and|so|well|then|also|hmm|um|uh|ok|okay|tell|me|please|pls|kindly|can|could|would|you|say|just|actually|about|regarding)$/;

const isGreeting = (trimmed: string): boolean => {
  const words = trimmed.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) return false;

  // Greedily consume the message left to right: each step must match a
  // small-talk fragment (or filler word) at the current position.
  let rest = words.join(' ');
  let sawFragment = false;
  while (rest.length > 0) {
    const next = rest.split(' ')[0];
    if (SMALL_TALK_FILLER.test(next)) {
      rest = rest.slice(next.length).trim();
      continue;
    }
    const hit = SMALL_TALK_FRAGMENTS
      .map(re => new RegExp(`^${re.source}(?=\\s|$)`).exec(rest))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return false;
    sawFragment = true;
    rest = rest.slice(hit[0].length).trim();
  }
  return sawFragment;
};

// A summary request must ask for a summary-type output AND target the whole
// lecture. "What are the key points of few-shot prompting?" or "summarize what
// the lecture says about tokenization" are topic questions: they go through
// retrieval, both relevance floors, answer memory and the verifier, which the
// summary path skips.
const SUMMARY_SIGNAL = /\b(?:summar(?:y|ize|ise|izing|ising|ies)|key\s+(?:points|takeaways|ideas)|main\s+(?:points|topics|ideas)|overview|recap|tl;?dr)\b/gi;
const WHOLE_LECTURE = /\b(?:this|the|whole|entire|full|today'?s)\s+(?:lecture|video|class|session|lesson)\b/gi;
const SUMMARY_FILLER = /\b(?:give|me|a|an|the|please|can|could|you|of|it|this|quick|short|brief|lecture|what|are|is)\b/gi;
// Phrases that only shape the answer — "in a table", "in the form of a
// numbered list", "in 5 bullet points", "in simple words", "in plain English",
// "as a list", "for me" — are not what is being asked about, so they are
// removed before looking for a topic. The output-format words come from the
// format detector, so a format it recognises ("in a table") can never again
// read as a topic here. They only count after "in"/"as": "the lecture on list
// comprehensions" is a topic.
const COUNT = String.raw`(?:\d+|a\s+few|one|two|three|four|five|six|seven|eight|nine|ten)`;
const SHAPE_WORD = `(?:${[
  ...FORMAT_REQUEST_WORDS, 'form', 'format', 'simple', 'plain', 'short', 'brief', 'detail', 'english', 'urdu',
  'sentences?', 'paragraphs?', 'words?', 'lines?', 'order', 'sequence',
].join('|')})`;
const ANSWER_SHAPE = new RegExp(
  String.raw`\b(?:in|as)\s+(?:the\s+form\s+of\s+)?(?:(?:a|an|the|your|my)\s+)?(?:own\s+)?(?:${COUNT}\s+)?(?:${SHAPE_WORD}\s+)*${SHAPE_WORD}\b`
  + String.raw`|\bfor\s+(?:me|us)\b`,
  'gi');
// "about X", "on X", "of X", "in X", "for X", "regarding X" — unless X is the
// whole lecture itself ("of this lecture") or a count ("in 5 minutes").
const TOPIC_QUALIFIER = new RegExp(
  String.raw`\b(?:about|regarding|concerning)\b|\b(?:of|on|in|for)\s+(?!(?:this|the|whole|entire|full|today'?s)\s+(?:lecture|video|class|session|lesson)\b)(?!${COUNT}\b)[a-z0-9]`,
  'i');

const isLectureSummaryRequest = (trimmed: string): boolean => {
  const lower = trimmed.toLowerCase();
  if (!new RegExp(SUMMARY_SIGNAL.source, 'i').test(lower)) return false;
  const asked = lower.replace(ANSWER_SHAPE, ' ');
  // Nothing left once the summary words, whole-lecture phrases and filler are
  // removed: "summarize", "summary please", "summarize it", "give me the key points".
  const rest = asked.replace(SUMMARY_SIGNAL, ' ').replace(WHOLE_LECTURE, ' ').replace(SUMMARY_FILLER, ' ')
    .replace(/[^a-z0-9]+/g, '');
  if (rest === '') return true;
  // Otherwise the whole lecture must be named, with no narrower topic.
  return new RegExp(WHOLE_LECTURE.source, 'i').test(asked) && !TOPIC_QUALIFIER.test(asked);
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

const ROUTE_RESPONSE_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    route: { type: 'STRING', enum: ROUTES },
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

const classifyWithLlm = async (question: string, timeoutMs: number): Promise<LectureQueryRoute | null> => {
  try {
    const provider = resolveLlmProvider(env.LLM.QUERY_ROUTER.PROVIDER);
    const model = env.LLM.QUERY_ROUTER.MODEL;
    const result = await withLlmDiagnostic(
      {
        spanName: 'router_call',
        operationType: 'ROUTE_CLASSIFICATION',
        provider: provider.name,
        model,
        invocationParams: { temperature: 0, maxOutputTokens: 64, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: `Student message:\n${question}`,
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        temperature: 0,
        maxOutputTokens: 64,
        thinking: env.LLM.QUERY_ROUTER.THINKING,
        responseSchema: ROUTE_RESPONSE_SCHEMA,
        timeoutMs,
      }),
      extractLlmUsage
    );
    return parseRouteResponse(result.raw);
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
    // llmCaller: keeps the deterministic test suite network/quota-free.
    llmClassifier?: typeof classifyWithLlm;
  } = {}
): Promise<RouteClassification> => {
  try {
    const ruleMatch = classifyByRule(question);
    if (ruleMatch) {
      return { route: ruleMatch, source: 'rule' };
    }

    const classifier = opts.llmClassifier ?? classifyWithLlm;
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
