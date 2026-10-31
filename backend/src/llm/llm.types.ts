// Provider-neutral types shared by every LLM-dependent service (query
// router, query rewriter, answer generator, lecture summarizer, prompt
// injection classifier) and by every provider adapter under providers/.
// Nothing in here may import a provider SDK — that's the whole point of
// this module. Provider-specific
// translation lives entirely inside providers/*.ts.

// A deliberately small JSON-schema-like subset — just enough to express the
// structured-output shapes this codebase actually needs (flat/nested
// objects, enums, arrays). Each provider adapter translates this into
// whatever schema shape its API wants (see json-schema.ts's toJsonSchema()).
export interface LlmSchema {
  type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';
  description?: string;
  enum?: string[];
  items?: LlmSchema;
  properties?: Record<string, LlmSchema>;
  required?: string[];
}

export type LlmThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface LlmRequest {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  // Provider-neutral reasoning effort. Each provider adapter translates it
  // into whatever its models accept (OpenAI: reasoning_effort, where
  // off/minimal/unset are "none") and clamps to what the model allows;
  // providers with no such control ignore it. Thinking tokens count against maxOutputTokens, so
  // small structured-output calls should keep this at 'off'/'minimal'.
  thinking?: LlmThinking;
  // When set, the provider must return JSON matching this shape in
  // `response.raw` (adapters handle whatever provider-specific flag turns
  // structured output on, e.g. OpenAI's strict json_schema response_format).
  responseSchema?: LlmSchema;
  // Aborts the underlying request — same AbortSignal.timeout() idiom used
  // everywhere else in this codebase (embedding/rerank).
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
