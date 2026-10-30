import { query } from '../config/database';
import { env } from '../config/env';
import type { LlmPrice } from '../config/env';
import { logger } from '../utils/logger';
import { ATTR, OpenInferenceSpanKind } from './otel-semconv';
import { isValidTraceId } from './tracer';
import type { FinishedSpan, FinishedTrace } from './types';

// One rag_request_log row per askLectureAgent call (migration 008). Metadata
// only — never question/answer text. Built from the FinishedTrace so the row
// and the Phoenix trace can never disagree about what happened.
export interface RequestLogRow {
  traceId: string;
  studentId: string | null;
  lectureId: number | null;
  sessionId: number | null;
  route: string | null;
  status: string;
  // Never null: the 008 partial index and NOT IN queries skip NULLs.
  responseStatus: string;
  notFoundReason: string | null;
  errorCode: string | null;
  memoryResult: string | null;
  answerVerificationReason: string | null;
  totalMs: number;
  stageMs: Record<string, number>;
  llmCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
  llmModel: string | null;
  exportedToPhoenix: boolean;
  schemaVersion: string | null;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v === '' ? null : v;
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
};

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

const tokenCount = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

// Sum of the span's own prompt/completion tokens at its model's price, or
// null when the model has no price or either token count is missing.
function spanCostUsd(span: FinishedSpan, pricing: Record<string, LlmPrice>): number | null {
  const model = str(span.metadata[ATTR.LLM_MODEL_NAME]);
  const price = model !== null && Object.prototype.hasOwnProperty.call(pricing, model) ? pricing[model] : undefined;
  const input = tokenCount(span.metadata[ATTR.LLM_TOKEN_COUNT_PROMPT]);
  const output = tokenCount(span.metadata[ATTR.LLM_TOKEN_COUNT_COMPLETION]);
  if (!price || input === null || output === null) return null;
  return (input / 1e6) * price.inputPer1M + (output / 1e6) * price.outputPer1M;
}

// PURE: no I/O, no clock. `pricing` defaults to the configured prices.
export function buildRequestLogRow(
  trace: FinishedTrace,
  exportedToPhoenix: boolean,
  pricing: Record<string, LlmPrice> = env.OBSERVABILITY.LLM_PRICING
): RequestLogRow {
  const attrs = trace.attributes;
  const llmSpans = trace.spans.filter(s => s.kind === OpenInferenceSpanKind.LLM);

  const stageMs: Record<string, number> = {};
  for (const s of trace.spans) {
    if (s.kind === OpenInferenceSpanKind.LLM) continue;
    stageMs[s.name] = (stageMs[s.name] ?? 0) + Math.round(s.durationMs);
  }

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const s of llmSpans) {
    const i = tokenCount(s.metadata[ATTR.LLM_TOKEN_COUNT_PROMPT]);
    const o = tokenCount(s.metadata[ATTR.LLM_TOKEN_COUNT_COMPLETION]);
    if (i !== null) inputTokens = (inputTokens ?? 0) + i;
    if (o !== null) outputTokens = (outputTokens ?? 0) + o;
  }

  // Priced only when every LLM call can be priced; a partial sum would
  // silently understate the cost.
  let estCostUsd: number | null = null;
  if (llmSpans.length > 0) {
    let total = 0;
    for (const s of llmSpans) {
      const c = spanCostUsd(s, pricing);
      if (c === null) { total = NaN; break; }
      total += c;
    }
    estCostUsd = Number.isNaN(total) ? null : Number(total.toFixed(6));
  }

  const answerSpan = trace.spans.find(s => s.name === 'generate-grounded-answer');
  const answerLlm = answerSpan
    ? llmSpans.find(s => s.parentSpanId === answerSpan.spanId)
    : undefined;
  const modelSpan = answerLlm ?? llmSpans[llmSpans.length - 1];

  return {
    traceId: trace.traceId,
    studentId: str(attrs.studentId),
    lectureId: int(attrs.lectureId),
    sessionId: int(attrs.sessionId),
    route: str(attrs.route),
    status: trace.status,
    responseStatus: str(attrs.responseStatus) ?? 'UNKNOWN',
    notFoundReason: str(attrs.notFoundReason),
    errorCode: trace.status === 'ERROR' ? trace.spans.find(s => s.errorCode)?.errorCode ?? null : null,
    memoryResult: str(attrs.memoryResult),
    answerVerificationReason: str(attrs.answerVerificationReason),
    totalMs: Math.round(trace.durationMs),
    stageMs,
    llmCalls: llmSpans.length,
    inputTokens,
    outputTokens,
    estCostUsd,
    llmModel: modelSpan ? str(modelSpan.metadata[ATTR.LLM_MODEL_NAME]) : null,
    exportedToPhoenix,
    schemaVersion: str(attrs.observabilitySchemaVersion),
  };
}

// Never throws: a request-log failure (e.g. Postgres down) must not touch
// the student's answer. Idempotent per trace via ON CONFLICT.
export async function writeRequestLog(row: RequestLogRow): Promise<void> {
  if (!env.OBSERVABILITY.REQUEST_LOG_ENABLED) return;
  if (!isValidTraceId(row.traceId)) {
    logger.debug(`[REQUEST_LOG] Skipping rag_request_log insert: invalid trace id "${String(row.traceId).slice(0, 40)}"`);
    return;
  }
  try {
    await query(
      `INSERT INTO rag_request_log (
         trace_id, student_id, lecture_id, session_id, route, status, response_status,
         not_found_reason, error_code, memory_result, answer_verification_reason,
         total_ms, stage_ms, llm_calls, input_tokens, output_tokens, est_cost_usd,
         llm_model, exported_to_phoenix, schema_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (trace_id) DO NOTHING`,
      [
        row.traceId, row.studentId, row.lectureId, row.sessionId, row.route, row.status, row.responseStatus,
        row.notFoundReason, row.errorCode, row.memoryResult, row.answerVerificationReason,
        row.totalMs, JSON.stringify(row.stageMs), row.llmCalls, row.inputTokens, row.outputTokens, row.estCostUsd,
        row.llmModel, row.exportedToPhoenix, row.schemaVersion,
      ]
    );
  } catch (err) {
    logger.warn(`[REQUEST_LOG] Failed to write rag_request_log for trace ${row.traceId} (non-fatal): ${(err as Error).message}`);
  }
}
