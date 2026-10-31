// Centralized OpenInference/OTel semantic-convention constants for this
// codebase. Every place that needs to name a span kind or a standard
// attribute key must import it from here instead of writing a raw string —
// keeps us aligned with what Phoenix actually understands, and means a
// convention-package upgrade only touches one file.
//
// Verified against the installed @arizeai/openinference-semantic-conventions
// version by reading its real source (src/trace/SemanticConventions.ts),
// not assumed from documentation.
import {
  OpenInferenceSpanKind,
  SemanticConventions as SC,
} from '@arizeai/openinference-semantic-conventions';

export { OpenInferenceSpanKind };

// The one attribute Phoenix actually uses to classify a span's kind in its
// UI (LLM / RETRIEVER / RERANKER / EMBEDDING / CHAIN / ...).
export const OPENINFERENCE_SPAN_KIND = SC.OPENINFERENCE_SPAN_KIND;

export const ATTR = {
  // Generic input/output
  INPUT_VALUE: SC.INPUT_VALUE,
  INPUT_MIME_TYPE: SC.INPUT_MIME_TYPE,
  OUTPUT_VALUE: SC.OUTPUT_VALUE,
  OUTPUT_MIME_TYPE: SC.OUTPUT_MIME_TYPE,

  // LLM
  LLM_MODEL_NAME: SC.LLM_MODEL_NAME,
  LLM_PROVIDER: SC.LLM_PROVIDER,
  LLM_SYSTEM: SC.LLM_SYSTEM,
  LLM_INVOCATION_PARAMETERS: SC.LLM_INVOCATION_PARAMETERS,
  LLM_INPUT_MESSAGES: SC.LLM_INPUT_MESSAGES,
  LLM_OUTPUT_MESSAGES: SC.LLM_OUTPUT_MESSAGES,
  LLM_TOKEN_COUNT_PROMPT: SC.LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_COMPLETION: SC.LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_TOTAL: SC.LLM_TOKEN_COUNT_TOTAL,
  MESSAGE_ROLE: SC.MESSAGE_ROLE,
  MESSAGE_CONTENT: SC.MESSAGE_CONTENT,

  // Embedding
  EMBEDDING_TEXT: SC.EMBEDDING_TEXT,
  EMBEDDING_VECTOR: SC.EMBEDDING_VECTOR,
  EMBEDDING_EMBEDDINGS: SC.EMBEDDING_EMBEDDINGS,
  EMBEDDING_MODEL_NAME: SC.EMBEDDING_MODEL_NAME,

  // Retrieval
  RETRIEVAL_DOCUMENTS: SC.RETRIEVAL_DOCUMENTS,
  DOCUMENT_ID: SC.DOCUMENT_ID,
  DOCUMENT_CONTENT: SC.DOCUMENT_CONTENT,
  DOCUMENT_SCORE: SC.DOCUMENT_SCORE,
  DOCUMENT_METADATA: SC.DOCUMENT_METADATA,

  // Reranker
  RERANKER_QUERY: SC.RERANKER_QUERY,
  RERANKER_MODEL_NAME: SC.RERANKER_MODEL_NAME,
  RERANKER_INPUT_DOCUMENTS: SC.RERANKER_INPUT_DOCUMENTS,
  RERANKER_OUTPUT_DOCUMENTS: SC.RERANKER_OUTPUT_DOCUMENTS,

  // Session / user grouping — this is what makes Phoenix's Sessions API
  // return real, non-empty data for our chat sessions.
  SESSION_ID: SC.SESSION_ID,
  USER_ID: SC.USER_ID,

  // Tags — free-form searchable labels (route, environment, etc.)
  TAG_TAGS: SC.TAG_TAGS,
} as const;

// Every stage name used by RequestTrace.span(...) across the pipeline, and
// the OpenInference span kind it must be exported as. Anything not listed
// here defaults to CHAIN (a safe, generic "orchestration step" kind) — see
// spanKindFor() below. Keeping this centralized means chat.service.ts (and
// any future call site) only has to get the *name* right; the kind mapping
// lives in exactly one place.
export const STAGE_SPAN_KIND: Record<string, OpenInferenceSpanKind> = {
  'ask-lecture-agent': OpenInferenceSpanKind.CHAIN,
  'load-agent-profile': OpenInferenceSpanKind.CHAIN,
  'validate-chat-session': OpenInferenceSpanKind.CHAIN,
  'input-guardrail': OpenInferenceSpanKind.CHAIN,
  'load-session-history': OpenInferenceSpanKind.CHAIN,
  'classify-query-route': OpenInferenceSpanKind.CHAIN,
  'rewrite-contextual-query': OpenInferenceSpanKind.CHAIN,
  'decompose-query': OpenInferenceSpanKind.CHAIN,
  'decomposed-retrieval': OpenInferenceSpanKind.RETRIEVER,
  'subquery-retrieval': OpenInferenceSpanKind.RETRIEVER,
  'adaptive-retrieval': OpenInferenceSpanKind.CHAIN,
  'adaptive-retrieval-iteration': OpenInferenceSpanKind.CHAIN,
  'exact-memory-lookup': OpenInferenceSpanKind.RETRIEVER,
  'generate-query-embedding': OpenInferenceSpanKind.EMBEDDING,
  'vector-search': OpenInferenceSpanKind.RETRIEVER,
  'rerank-candidates': OpenInferenceSpanKind.RERANKER,
  'fetch-all-lecture-chunks': OpenInferenceSpanKind.RETRIEVER,
  'summarize-lecture-content': OpenInferenceSpanKind.CHAIN,
  'generate-grounded-answer': OpenInferenceSpanKind.CHAIN,
  'output-guardrail': OpenInferenceSpanKind.CHAIN,
  'generate-greeting-response': OpenInferenceSpanKind.CHAIN,
  'save-chat-entry': OpenInferenceSpanKind.CHAIN,
  'write-answer-memory': OpenInferenceSpanKind.CHAIN,
  'record-memory-hit': OpenInferenceSpanKind.CHAIN,

  // Nested Gemini call spans (children of the CHAIN spans above)
  gemini_router_call: OpenInferenceSpanKind.LLM,
  gemini_rewriter_call: OpenInferenceSpanKind.LLM,
  gemini_answer_call: OpenInferenceSpanKind.LLM,
  gemini_summary_batch_call: OpenInferenceSpanKind.LLM,
  gemini_summary_combine_call: OpenInferenceSpanKind.LLM,

  // Provider-neutral LLM call spans (src/llm/llm-observability.service.ts) —
  // named after the operation rather than a provider, since the underlying
  // provider is now a runtime config choice, not a fixed identity.
  greeting_response_call: OpenInferenceSpanKind.LLM,
  prompt_injection_classifier_call: OpenInferenceSpanKind.LLM,
  subquery_decomposition_call: OpenInferenceSpanKind.LLM,
  adaptive_retrieval_planner_call: OpenInferenceSpanKind.LLM,
  answer_groundedness_verifier_call: OpenInferenceSpanKind.LLM,
  answer_revision_call: OpenInferenceSpanKind.LLM,
  response_format_repair_call: OpenInferenceSpanKind.LLM,
};

export function spanKindFor(name: string): OpenInferenceSpanKind {
  return STAGE_SPAN_KIND[name] ?? OpenInferenceSpanKind.CHAIN;
}
