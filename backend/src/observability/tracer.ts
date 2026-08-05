import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import type { FinishedSpan, FinishedTrace, SafeMetadata, SpanStatus } from './types';

// Coarse, safe error classification — never includes the raw error message
// (which could contain question/answer text via a thrown validation error,
// a stack trace with file paths, etc.). Callers needing more detail should
// look at server logs, not exported traces.
export function classifyErrorCode(err: unknown): string {
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('aborted')) return 'TIMEOUT';
  if (msg.includes('not reachable') || msg.includes('econnrefused') || msg.includes('fetch failed')) return 'SERVICE_UNREACHABLE';
  if (msg.includes('rate limit') || msg.includes('quota') || msg.includes('resource_exhausted') || msg.includes('429')) return 'RATE_LIMITED';
  if (msg.includes('service unavailable') || msg.includes('503') || msg.includes('high demand')) return 'SERVICE_UNAVAILABLE';
  if (msg.includes('invalid input syntax') || msg.includes('violates') || msg.includes('constraint')) return 'DB_CONSTRAINT_ERROR';
  if (msg.includes('econnrefused') || msg.includes('connection')) return 'CONNECTION_ERROR';
  return 'UNKNOWN_ERROR';
}

// One RequestTrace per askLectureAgent call. Accumulates child spans, then
// finishes into a plain, serializable FinishedTrace. Never throws from its
// own bookkeeping — a bug in tracing must not become a bug in the student's
// request. `span()` is the one exception: if the wrapped function throws, a
// FAILED span is recorded and the original error is rethrown unchanged, so
// wrapping a call in a span never hides or alters its real failure.
export class RequestTrace {
  readonly traceId: string;
  private readonly rootName: string;
  private readonly startedAtMs: number;
  private readonly startedAtHr: bigint;
  private readonly spans: FinishedSpan[] = [];
  private attributes: SafeMetadata = {};
  private ended = false;

  constructor(rootName: string, traceId?: string) {
    this.rootName = rootName;
    this.traceId = traceId ?? randomUUID();
    this.startedAtMs = Date.now();
    this.startedAtHr = process.hrtime.bigint();
  }

  setAttributes(attrs: SafeMetadata): void {
    Object.assign(this.attributes, attrs);
  }

  async span<T>(
    name: string,
    fn: () => Promise<T>,
    metadataFn?: (result: T) => SafeMetadata,
    // Lets a stage report FALLBACK instead of SUCCESS on its own result
    // (e.g. a rewrite that was attempted but fell back) without treating
    // it as an ERROR — the call still completed without throwing.
    statusFn?: (result: T) => SpanStatus
  ): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      const status = statusFn ? safeCall(() => statusFn(result), 'SUCCESS') : 'SUCCESS';
      this.pushSpan(name, start, status, metadataFn ? safeCall(() => metadataFn(result), {}) : {});
      return result;
    } catch (err) {
      this.pushSpan(name, start, 'ERROR', {}, classifyErrorCode(err));
      throw err;
    }
  }

  // For a stage that ran but fell back to a safe default rather than fully
  // succeeding (e.g. router LLM classification failed -> SAFE_DEFAULT).
  recordFallback(name: string, durationMs: number, metadata: SafeMetadata = {}): void {
    this.spans.push({ name, startedAt: Date.now() - durationMs, durationMs, status: 'FALLBACK', metadata });
  }

  end(status: SpanStatus, extraAttrs: SafeMetadata = {}): FinishedTrace {
    if (this.ended) {
      // Defensive — a double-end would only happen from a tracing bug, not
      // a request bug. Log and return the already-finished shape rather
      // than throwing.
      logger.warn(`[OBSERVABILITY] Trace ${this.traceId} ended more than once — ignoring second call`);
    }
    this.ended = true;
    Object.assign(this.attributes, extraAttrs);
    const durationMs = Number(process.hrtime.bigint() - this.startedAtHr) / 1e6;
    return {
      traceId: this.traceId,
      rootName: this.rootName,
      startedAt: this.startedAtMs,
      durationMs,
      status,
      attributes: this.attributes,
      spans: this.spans,
    };
  }

  private pushSpan(name: string, startHr: bigint, status: SpanStatus, metadata: SafeMetadata, errorCode?: string): void {
    const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
    this.spans.push({
      name,
      startedAt: Date.now() - durationMs,
      durationMs,
      status,
      metadata,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logger.warn(`[OBSERVABILITY] Span metadata/status callback failed: ${(err as Error).message}`);
    return fallback;
  }
}

// Default sink for a finished trace: safe-by-default, never throws, never
// blocks the response (caller should not await this on the response path
// if it can be avoided — chat.service.ts fires this after building the
// response). Phase 1: Phoenix export + a concise log line. Phase 2 will
// extend this to also persist into rag_request_traces/rag_trace_spans.
export async function recordTrace(trace: FinishedTrace): Promise<void> {
  try {
    logger.info(
      `[TRACE] ${trace.rootName} id=${trace.traceId} status=${trace.status} durationMs=${trace.durationMs.toFixed(1)} spans=${trace.spans.length} route=${trace.attributes.route ?? 'n/a'}`
    );
    const { exportTraceToPhoenix } = await import('./phoenix');
    await exportTraceToPhoenix(trace);
  } catch (err) {
    logger.warn(`[OBSERVABILITY] recordTrace failed (non-fatal): ${(err as Error).message}`);
  }
}
