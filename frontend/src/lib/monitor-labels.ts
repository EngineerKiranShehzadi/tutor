// Code -> plain-language labels for the admin monitor. The backend stores
// machine codes (rag_request_log.response_status, not_found_reason,
// error_code, stage_ms keys); the monitor UI must never show those raw.
// Unknown codes fall back to a generic label, not the code itself.

export const RESPONSE_STATUS_LABELS: Record<string, string> = {
  ANSWERED: 'Answered',
  MEMORY_HIT_ANSWERED: 'Answered (from memory)',
  GREETING_ANSWERED: 'Greeting answered',
  SUMMARY_ANSWERED: 'Lecture summary given',
  NOT_FOUND: 'Not found in lecture',
  GUARDRAIL_REJECTED: 'Question not accepted',
  LECTURE_NOT_READY: 'Lecture not ready yet',
  ERROR: 'Something went wrong',
};

export const NOT_FOUND_REASON_LABELS: Record<string, string> = {
  EMPTY_LECTURE: 'The lecture has no content yet',
  SUMMARY_CONTENT_EMPTY: 'No content available to summarize',
  NO_VECTOR_CANDIDATES: 'Nothing in the lecture matched the question',
  ALL_CANDIDATES_BELOW_RERANK_FLOOR: 'Matches found were too weak to use',
};

export const ERROR_CODE_LABELS: Record<string, string> = {
  TIMEOUT: 'The answer took too long',
  SERVICE_UNREACHABLE: 'A service could not be reached',
  SERVICE_UNAVAILABLE: 'The AI model is busy',
  RATE_LIMITED: 'The AI model usage limit was reached',
  DB_CONSTRAINT_ERROR: 'The database rejected the data',
  CONNECTION_ERROR: 'The connection was lost',
  EXTENSION_NOT_INSTALLED: 'A required database extension is not installed',
  NOT_CONFIGURED: 'Setup is incomplete',
  UNKNOWN_ERROR: 'Unknown problem',
};

// Keys of rag_request_log.stage_ms (span names in the chat pipeline).
export const STAGE_LABELS: Record<string, string> = {
  'validate-chat-session': 'Session check',
  'load-agent-profile': 'Loading lecture settings',
  'load-session-history': 'Loading earlier conversation',
  'input-guardrail': 'Checking the question',
  'classify-query-route': 'Identifying question type',
  'rewrite-contextual-query': 'Rewriting the question',
  'decompose-query': 'Splitting the question into parts',
  'exact-memory-lookup': 'Looking up earlier answers',
  'generate-query-embedding': 'Converting question to embedding',
  'vector-search': 'Searching the lecture',
  'adaptive-retrieval': 'Searching the lecture (adaptive)',
  'decomposed-retrieval': 'Searching the lecture (by parts)',
  'fetch-all-lecture-chunks': 'Loading the full lecture',
  'rerank-candidates': 'Picking the best passages',
  'generate-grounded-answer': 'Writing the answer',
  'generate-greeting-response': 'Writing the greeting',
  'summarize-lecture-content': 'Summarizing the lecture',
  'ask-lecture-agent': 'Asking the lecture agent',
  'llm-fallback': 'Switching to backup AI model',
  'output-guardrail': 'Checking the answer',
  'record-memory-hit': 'Recording memory use',
  'write-answer-memory': 'Saving answer to memory',
  'save-chat-entry': 'Saving the conversation',
};

// answer_verification_reason (post-generation verifier).
export const VERIFIER_REASON_LABELS: Record<string, string> = {
  VERIFIED: 'Answer verified against the lecture',
  GROUNDED: 'Answer verified against the lecture',
  REVISE: 'Answer had to be rewritten',
  UNSUPPORTED_CLAIM: 'Answer contained a claim not in the lecture',
  UNSUPPORTED_CLAIMS: 'Answer contained claims not in the lecture',
};

// Why a request needs attention (monitor attention list).
export const ATTENTION_REASON_LABELS: Record<string, string> = {
  error: 'Error',
  not_answered: 'Not answered',
  verifier: 'Failed answer check',
  slow: 'Slow',
};

// Specific one-line explanation shown next to the reason chips in the
// attention table. Written as the whole sentence, not a name.
export const ATTENTION_NOT_FOUND_LABELS: Record<string, string> = {
  EMPTY_LECTURE: 'Not found — the lecture has no content',
  SUMMARY_CONTENT_EMPTY: 'Not found — nothing to summarize',
  NO_VECTOR_CANDIDATES: 'Not found — no matching content',
  ALL_CANDIDATES_BELOW_RERANK_FLOOR: 'Not found — matches were too weak',
};

export const ATTENTION_ERROR_LABELS: Record<string, string> = {
  TIMEOUT: 'Answer timed out',
  SERVICE_UNREACHABLE: 'A service could not be reached',
  SERVICE_UNAVAILABLE: 'AI service busy',
  RATE_LIMITED: 'AI service rate limit',
  DB_CONSTRAINT_ERROR: 'Database rejected the data',
  CONNECTION_ERROR: 'Connection lost',
  EXTENSION_NOT_INSTALLED: 'Database extension missing',
  NOT_CONFIGURED: 'Setup is incomplete',
  UNKNOWN_ERROR: 'Unknown problem',
};

export const ATTENTION_VERIFIER_LABELS: Record<string, string> = {
  REVISE: 'Answer changed by verifier',
  UNSUPPORTED_CLAIM: 'Answer had a claim not in the lecture',
  UNSUPPORTED_CLAIMS: 'Answer had claims not in the lecture',
};

// /health/ready component keys.
export const COMPONENT_LABELS: Record<string, string> = {
  database: 'Database',
  pgvector: 'Vector search',
  embeddingServer: 'Embedding server',
  reranker: 'Reranker',
  gemini: 'AI model',
};

const GENERIC = {
  responseStatus: 'Unknown outcome',
  notFoundReason: 'Reason unknown',
  errorCode: 'Unknown problem',
  stage: 'Other step',
  verifierReason: 'Check result unknown',
  attentionReason: 'Needs attention',
  component: 'A service',
} as const;

const pick = (map: Record<string, string>, code: string | null | undefined, fallback: string): string =>
  (code != null && Object.prototype.hasOwnProperty.call(map, code) ? map[code] : fallback);

export const responseStatusLabel = (c?: string | null) => pick(RESPONSE_STATUS_LABELS, c, GENERIC.responseStatus);
export const notFoundReasonLabel = (c?: string | null) => pick(NOT_FOUND_REASON_LABELS, c, GENERIC.notFoundReason);
export const errorCodeLabel = (c?: string | null) => pick(ERROR_CODE_LABELS, c, GENERIC.errorCode);
export const stageLabel = (c?: string | null) => pick(STAGE_LABELS, c, GENERIC.stage);
export const verifierReasonLabel = (c?: string | null) => pick(VERIFIER_REASON_LABELS, c, GENERIC.verifierReason);
export const attentionReasonLabel = (c?: string | null) => pick(ATTENTION_REASON_LABELS, c, GENERIC.attentionReason);
export const componentLabel = (c?: string | null) => pick(COMPONENT_LABELS, c, GENERIC.component);

// One specific label per cause on an attention row (error code, outcome,
// verifier result). Never returns a raw code.
export function attentionDetailLabels(row: {
  responseStatus?: string | null;
  notFoundReason?: string | null;
  errorCode?: string | null;
  answerVerificationReason?: string | null;
}): string[] {
  const out: string[] = [];
  if (row.errorCode) out.push(pick(ATTENTION_ERROR_LABELS, row.errorCode, GENERIC.errorCode));
  if (row.responseStatus === 'NOT_FOUND') {
    out.push(pick(ATTENTION_NOT_FOUND_LABELS, row.notFoundReason, 'Not found in lecture'));
  } else if (row.responseStatus === 'GUARDRAIL_REJECTED') {
    out.push('Rejected by safety check');
  } else if (row.responseStatus === 'LECTURE_NOT_READY') {
    out.push('Lecture not ready yet');
  } else if (row.responseStatus === 'ERROR' && !row.errorCode) {
    out.push('Something went wrong');
  }
  const v = row.answerVerificationReason;
  if (v && v !== 'VERIFIED') out.push(pick(ATTENTION_VERIFIER_LABELS, v, GENERIC.verifierReason));
  return out;
}
