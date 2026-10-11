// Provider-neutral types shared by every LLM-dependent service (query
// router, query rewriter, answer generator, lecture summarizer, prompt
// injection classifier) and by every provider adapter under providers/.
// Nothing in here may import from '@google/genai' (or any other provider
// SDK) — that's the whole point of this module. Provider-specific
// translation lives entirely inside providers/*.ts.

// A deliberately small JSON-schema-like subset — just enough to express the
// structured-output shapes this codebase actually needs (flat/nested
// objects, enums, arrays). Each provider adapter translates this into
// whatever schema shape its own SDK wants (see providers/gemini-llm.
// provider.ts's toGeminiSchema()).
export interface LlmSchema {
  type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';
  description?: string;
  enum?: string[];
  items?: LlmSchema;
  properties?: Record<string, LlmSchema>;
  required?: string[];
}

export interface LlmRequest {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  // 0 disables model "thinking" so it can't consume maxOutputTokens (honored
  // by providers that support it, ignored otherwise).
  thinkingBudget?: number;
  // When set, the provider must return JSON matching this shape in
  // `response.raw` (adapters handle whatever provider-specific flag turns
  // structured output on, e.g. Gemini's responseMimeType+responseSchema).
  responseSchema?: LlmSchema;
  // Aborts the underlying request — same AbortSignal.timeout() idiom used
  // everywhere else in this codebase (embedding/rerank/gemini-provider).
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  // Always the provider's raw text response. Callers that parse structured
  // JSON output do so themselves (see query-router.service.ts's
  // parseRouteResponse, query-rewriter.service.ts's parseRewriteResponse) —
  // keeping parsing in the caller (not this contract) means those pure,
  // already-unit-tested functions never had to change shape.
  raw: string;
  provider: string;
  model: string;
  finishReason?: string;
  usage?: LlmUsage;
}

// Every operation type any LLM-dependent service in this codebase performs.
// Used purely for observability labeling (llm.operation) — never changes
// request/response behavior.
export type LlmOperationType =
  | 'ROUTE_CLASSIFICATION'
  | 'QUERY_REWRITE'
  | 'GROUNDED_ANSWER'
  | 'PARTIAL_SUMMARY'
  | 'FINAL_SUMMARY'
  | 'PROMPT_INJECTION_CLASSIFICATION'
  | 'QUERY_DECOMPOSITION'
  | 'ADAPTIVE_RETRIEVAL_PLANNING'
  | 'ANSWER_VERIFICATION'
  | 'ANSWER_REVISION'
  | 'FORMAT_REPAIR'
  | 'GREETING_RESPONSE';
