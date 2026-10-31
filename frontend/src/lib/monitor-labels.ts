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

// Keys of rag_request_log.stage_ms: the chat pipeline's span names, mirroring
// backend observability/otel-semconv.ts STAGE_SPAN_KIND. LLM-call spans
// (*_call) are never keys — request-log.service.ts leaves them out of stage_ms.
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
  'subquery-retrieval': 'Searching the lecture for one part',
  'adaptive-retrieval-iteration': 'Searching again for a missing part',
  'fetch-all-lecture-chunks': 'Loading the full lecture',
  'rerank-candidates': 'Picking the best passages',
  'generate-grounded-answer': 'Writing the answer',
  'generate-greeting-response': 'Writing the greeting',
  'summarize-lecture-content': 'Summarizing the lecture',
  'ask-lecture-agent': 'Asking the lecture agent',
  'output-guardrail': 'Checking the answer',
  'record-memory-hit': 'Recording memory use',
  'write-answer-memory': 'Saving answer to memory',
  'save-chat-entry': 'Saving the conversation',
};

// answer_verification_reason (post-generation verifier). Keys are the
// backend's OUTPUT_GUARDRAIL_REASONS (rag/guardrails/output/
// answer-verification.types.ts). VERIFIER_*, REVISION_FAILED and
// FINAL_VERIFICATION_FAILED mean the check could not run (an outage), not
// that the answer was wrong.
export const VERIFIER_REASON_LABELS: Record<string, string> = {
  VERIFIED: 'Answer verified against the lecture',
  UNSUPPORTED_CLAIMS: 'Answer contained claims not in the lecture',
  CONTRADICTS_EVIDENCE: 'Answer contradicted the lecture',
  ANSWERED_UNCOVERED_ASPECT: 'Answer covered a part the lecture does not',
  INSUFFICIENT_EVIDENCE: 'The lecture did not support the answer',
  VERIFIER_TIMEOUT: 'Answer check timed out',
  VERIFIER_PROVIDER_ERROR: 'Answer check service failed',
  VERIFIER_INVALID_OUTPUT: 'Answer check gave an unreadable result',
  REVISION_FAILED: 'Answer correction could not run',
  FINAL_VERIFICATION_FAILED: 'Corrected answer could not be re-checked',
  VERIFICATION_DISABLED: 'Answer check is turned off',
  REVISED_AND_VERIFIED: 'Answer corrected, then verified',
  REVISED_BUT_UNVERIFIED: 'Answer still unsupported after correction',
};

// Why a request needs attention (monitor attention list).
// rag_request_log.format_repair_rejected: why a requested list/table was not
// served (the student got the answer as plain text).
export const FORMAT_REJECTED_LABELS: Record<string, string> = {
  NEW_CONTENT: 'Sent as plain text: reformatting added content',
  LOST_CONTENT: 'Sent as plain text: reformatting dropped content',
};

export const ATTENTION_REASON_LABELS: Record<string, string> = {
  error: 'Error',
  not_answered: 'Not answered',
  verifier: 'Failed answer check',
  format: 'List/table not delivered',
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

// Why a lecture was "not ready" (stored as e.g. "MISSING_EMBEDDINGS 2/5").
export const ATTENTION_NOT_READY_LABELS: Record<string, string> = {
  NO_ACTIVE_VERSION: 'Lecture not ready — no dataset has been published',
  EMPTY_ACTIVE_VERSION: 'Lecture not ready — the published dataset is empty',
  MISSING_EMBEDDINGS: 'Lecture not ready — some answers are not searchable yet',
  STALE_EMBEDDING_MODEL: 'Lecture not ready — some answers need re-processing',
};

function notReadyLabel(reason?: string | null): string {
  if (!reason) return 'Lecture not ready yet';
  const [code, counts] = reason.split(' ');
  const base = pick(ATTENTION_NOT_READY_LABELS, code, 'Lecture not ready yet');
  return counts && /^\d+\/\d+$/.test(counts) ? `${base} (${counts})` : base;
}

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

// Same keys as VERIFIER_REASON_LABELS; outages say so, so a verifier outage
// never reads like a wrong answer.
export const ATTENTION_VERIFIER_LABELS: Record<string, string> = {
  UNSUPPORTED_CLAIMS: 'Answer had claims not in the lecture',
  CONTRADICTS_EVIDENCE: 'Answer contradicted the lecture',
  ANSWERED_UNCOVERED_ASPECT: 'Answer went beyond what the lecture covers',
  INSUFFICIENT_EVIDENCE: 'Lecture did not support the answer',
  VERIFIER_TIMEOUT: 'Answer check timed out (outage)',
  VERIFIER_PROVIDER_ERROR: 'Answer check unavailable (outage)',
  VERIFIER_INVALID_OUTPUT: 'Answer check gave an unreadable result (outage)',
  REVISION_FAILED: 'Answer correction could not run (outage)',
  FINAL_VERIFICATION_FAILED: 'Corrected answer could not be re-checked (outage)',
  VERIFICATION_DISABLED: 'Answer check is turned off',
  REVISED_AND_VERIFIED: 'Answer was corrected, then passed the check',
  REVISED_BUT_UNVERIFIED: 'Answer still unsupported after correction',
};

// /health/ready component keys.
export const COMPONENT_LABELS: Record<string, string> = {
  database: 'Database',
  pgvector: 'Vector search',
  embeddingServer: 'Embedding server',
  reranker: 'Reranker',
  answerLlm: 'AI model',
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
  formatRepairRejected?: string | null;
}): string[] {
  const out: string[] = [];
  if (row.errorCode) out.push(pick(ATTENTION_ERROR_LABELS, row.errorCode, GENERIC.errorCode));
  if (row.responseStatus === 'NOT_FOUND') {
    out.push(pick(ATTENTION_NOT_FOUND_LABELS, row.notFoundReason, 'Not found in lecture'));
  } else if (row.responseStatus === 'GUARDRAIL_REJECTED') {
    out.push('Rejected by safety check');
  } else if (row.responseStatus === 'LECTURE_NOT_READY') {
    out.push(notReadyLabel(row.notFoundReason));
  } else if (row.responseStatus === 'ERROR' && !row.errorCode) {
    out.push('Something went wrong');
  }
  const v = row.answerVerificationReason;
  // Same as the backend's NON_PROBLEM_VERIFIER_REASONS: a check that is
  // switched off is not a problem with this answer.
  if (v && v !== 'VERIFIED' && v !== 'VERIFICATION_DISABLED') out.push(pick(ATTENTION_VERIFIER_LABELS, v, GENERIC.verifierReason));
  if (row.formatRepairRejected) out.push(pick(FORMAT_REJECTED_LABELS, row.formatRepairRejected, 'Asked-for list/table not delivered'));
  return out;
}
