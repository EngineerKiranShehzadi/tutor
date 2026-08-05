import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../utils/logger';
import { spanKindFor, OpenInferenceSpanKind } from './otel-semconv';
import type { FinishedSpan, FinishedTrace, SafeMetadata, SpanStatus, SpanEvent } from './types';

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

function generateSpanId(): string {
  // 16 hex chars — same width as a real OTel span ID, so it reads naturally
  // next to Phoenix-native IDs in logs/UI even though it isn't one itself
  // (phoenix.ts maps it to a real OTel span at export time).
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

interface ActiveSpanContext {
  trace: RequestTrace;
  parentSpanId: string;
}

// Lets a deeply-nested service call (query-router, llm-gemini, etc.) find
// "the current request's trace and current parent span" without the trace
// object being threaded through every function signature in the pipeline.
// AsyncLocalStorage correctly propagates across every await in the chain,
// so a `trace.span()` call made from inside another `trace.span()`'s fn —
// no matter how many modules deep — automatically becomes a real child.
const spanContextStorage = new AsyncLocalStorage<ActiveSpanContext>();

export function getActiveTrace(): RequestTrace | null {
  return spanContextStorage.getStore()?.trace ?? null;
}

// One RequestTrace per askLectureAgent call. Accumulates child spans (with
// real spanId/parentSpanId hierarchy — see span() below), then finishes
// into a plain, serializable FinishedTrace. Never throws from its own
// bookkeeping — a bug in tracing must not become a bug in the student's
// request. `span()` is the one exception: if the wrapped function throws, a
// FAILED span is recorded and the original error is rethrown unchanged, so
// wrapping a call in a span never hides or alters its real failure.
export class RequestTrace {
  readonly traceId: string;
  readonly rootSpanId: string;
  private readonly rootName: string;
  private readonly startedAtMs: number;
  private readonly startedAtHr: bigint;
  private readonly spans: FinishedSpan[] = [];
  private attributes: SafeMetadata = {};
  private ended = false;

  constructor(rootName: string, traceId?: string) {
    this.rootName = rootName;
    this.traceId = traceId ?? randomUUID();
    this.rootSpanId = generateSpanId();
    this.startedAtMs = Date.now();
    this.startedAtHr = process.hrtime.bigint();
  }

  setAttributes(attrs: SafeMetadata): void {
    Object.assign(this.attributes, attrs);
  }

  // Runs `fn` with this trace registered as "the active trace" for its
  // entire (possibly async, possibly multi-module) call chain. Must wrap
  // the whole body of the top-level orchestrator (askLectureAgent) — every
  // trace.span() call made anywhere underneath, directly or via a nested
  // service function, then attaches to the real call-stack parent instead
  // of always the root.
  runAsActive<T>(fn: () => Promise<T>): Promise<T> {
    return spanContextStorage.run({ trace: this, parentSpanId: this.rootSpanId }, fn);
  }

  async span<T>(
    name: string,
    fn: () => Promise<T>,
    metadataFn?: (result: T) => SafeMetadata,
    // Lets a stage report FALLBACK instead of SUCCESS on its own result
    // (e.g. a rewrite that was attempted but fell back) without treating
    // it as an ERROR — the call still completed without throwing.
    statusFn?: (result: T) => SpanStatus,
    kindOverride?: OpenInferenceSpanKind
  ): Promise<T> {
    const parentCtx = spanContextStorage.getStore();
    const parentSpanId = parentCtx && parentCtx.trace === this ? parentCtx.parentSpanId : this.rootSpanId;
    const spanId = generateSpanId();
    const kind = kindOverride ?? spanKindFor(name);
    const events: SpanEvent[] = [];
    const start = process.hrtime.bigint();

    const runChild = () => spanContextStorage.run({ trace: this, parentSpanId: spanId }, fn);

    try {
      const result = await runChild();
      const status = statusFn ? safeCall(() => statusFn(result), 'SUCCESS') : 'SUCCESS';
      this.pushSpan({
        spanId, parentSpanId, name, kind, start, status,
        metadata: metadataFn ? safeCall(() => metadataFn(result), {}) : {},
        events,
      });
      return result;
    } catch (err) {
      this.pushSpan({
        spanId, parentSpanId, name, kind, start, status: 'ERROR',
        metadata: {}, events,
        errorCode: classifyErrorCode(err),
        exception: {
          errorCode: classifyErrorCode(err),
          message: String((err as Error)?.message ?? 'Unknown error').slice(0, 500),
        },
      });
      throw err;
    }
  }

  // Records a discrete event on the currently-active span (e.g. a retry
  // attempt, a fallback trigger) without creating a whole new span for it.
  // No-op if called outside any span() — safe to call speculatively.
  addEvent(name: string, attributes?: SafeMetadata): void {
    const parentCtx = spanContextStorage.getStore();
    if (!parentCtx || parentCtx.trace !== this) return;
    const target = this.spans.find(s => s.spanId === parentCtx.parentSpanId);
    // The active span hasn't finished (and therefore hasn't been pushed)
    // yet when addEvent is called from inside it — buffer separately isn't
    // needed since pendingEvents below covers this via spanId lookup at
    // push time instead.
    if (target) target.events.push({ name, timestamp: Date.now(), attributes });
    else this.pendingEvents.push({ spanId: parentCtx.parentSpanId, event: { name, timestamp: Date.now(), attributes } });
  }

  private pendingEvents: { spanId: string; event: SpanEvent }[] = [];

  // For a stage that ran but fell back to a safe default rather than fully
  // succeeding (e.g. router LLM classification failed -> SAFE_DEFAULT).
  recordFallback(name: string, durationMs: number, metadata: SafeMetadata = {}): void {
    const parentCtx = spanContextStorage.getStore();
    const parentSpanId = parentCtx && parentCtx.trace === this ? parentCtx.parentSpanId : this.rootSpanId;
    this.spans.push({
      spanId: generateSpanId(), parentSpanId, name, kind: spanKindFor(name),
      startedAt: Date.now() - durationMs, durationMs, status: 'FALLBACK', metadata, events: [],
    });
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
      rootSpanId: this.rootSpanId,
      rootName: this.rootName,
      startedAt: this.startedAtMs,
      durationMs,
      status,
      attributes: this.attributes,
      spans: this.spans,
    };
  }

  private pushSpan(args: {
    spanId: string; parentSpanId: string; name: string; kind: OpenInferenceSpanKind;
    start: bigint; status: SpanStatus; metadata: SafeMetadata; events: SpanEvent[];
    errorCode?: string; exception?: FinishedSpan['exception'];
  }): void {
    const durationMs = Number(process.hrtime.bigint() - args.start) / 1e6;
    const bufferedEvents = this.pendingEvents.filter(e => e.spanId === args.spanId).map(e => e.event);
    this.pendingEvents = this.pendingEvents.filter(e => e.spanId !== args.spanId);
    this.spans.push({
      spanId: args.spanId,
      parentSpanId: args.parentSpanId,
      name: args.name,
      kind: args.kind,
      startedAt: Date.now() - durationMs,
      durationMs,
      status: args.status,
      metadata: args.metadata,
      events: [...args.events, ...bufferedEvents],
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.exception ? { exception: args.exception } : {}),
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
// response). Phase 1: Phoenix export + a concise log line.
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
