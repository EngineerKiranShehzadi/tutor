import { env } from '../config/env';
import { logger } from '../utils/logger';
import { OPENINFERENCE_SPAN_KIND, ATTR } from './otel-semconv';
import { sanitizeAttributes, sanitizeValue, isContentCaptureEnabled } from './sanitize';
import type { FinishedTrace, FinishedSpan } from './types';

// Optional, best-effort export of our own internal traces to Phoenix over
// OTLP. Fully inert unless both OBSERVABILITY_ENABLED and PHOENIX_ENABLED
// are true — the OpenTelemetry SDK is never even initialized otherwise, so
// a missing/unreachable Phoenix instance can never affect a student
// request. Our own in-process tracer (tracer.ts) is the source of truth;
// this is a one-way side channel for developer-level trace inspection.
//
// The real hierarchy fix lives here: each FinishedSpan carries a real
// spanId/parentSpanId (see tracer.ts). Instead of parenting every span
// directly under root (the old bug), we walk the actual parent/child tree
// and only ever start a child span once its real parent's OTel Span object
// exists, so Phoenix receives the genuine pipeline shape.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tracerProvider: any = null;
let initFailed = false;

async function getOtelTracer() {
  if (initFailed) return null;
  if (tracerProvider) return tracerProvider.getTracer('askaitutor-rag');

  if (!env.OBSERVABILITY.PHOENIX_ENDPOINT) {
    logger.warn('[PHOENIX] PHOENIX_ENABLED is true but PHOENIX_ENDPOINT is not set — Phoenix export disabled');
    initFailed = true;
    return null;
  }

  try {
    const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
    const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

    const headers: Record<string, string> = {};
    if (env.OBSERVABILITY.PHOENIX_API_KEY) {
      headers.Authorization = `Bearer ${env.OBSERVABILITY.PHOENIX_API_KEY}`;
    }

    const exporter = new OTLPTraceExporter({ url: env.OBSERVABILITY.PHOENIX_ENDPOINT, headers });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'askaitutor-backend',
        // Phoenix groups traces into "projects" by this resource attribute.
        'openinference.project.name': env.OBSERVABILITY.PHOENIX_PROJECT_NAME,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    tracerProvider = provider;
    logger.info(`[PHOENIX] Exporter initialized -> ${env.OBSERVABILITY.PHOENIX_ENDPOINT}`);
    return tracerProvider.getTracer('askaitutor-rag');
  } catch (err) {
    logger.warn(`[PHOENIX] Failed to initialize OpenTelemetry exporter (Phoenix export disabled for this process): ${(err as Error).message}`);
    initFailed = true;
    return null;
  }
}

function setSafeAttributes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  span: any,
  attrs: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(sanitizeAttributes(attrs as Record<string, unknown>))) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      // OTel attribute values must be primitive/array-of-primitive — objects
      // are stringified rather than dropped, so debugging info isn't lost.
      span.setAttribute(key, JSON.stringify(value));
    } else {
      span.setAttribute(key, value as string | number | boolean);
    }
  }
}

export async function exportTraceToPhoenix(trace: FinishedTrace): Promise<void> {
  if (!env.OBSERVABILITY.ENABLED || !env.OBSERVABILITY.PHOENIX_ENABLED) return;
  if (env.OBSERVABILITY.SAMPLE_RATE < 1 && Math.random() > env.OBSERVABILITY.SAMPLE_RATE) return;

  try {
    const { trace: otelTrace, context: otelContext, SpanStatusCode } = await import('@opentelemetry/api');
    const tracer = await getOtelTracer();
    if (!tracer) return;

    const rootStart = trace.startedAt;
    const rootEnd = trace.startedAt + trace.durationMs;
    const rootSpan = tracer.startSpan(trace.rootName, { startTime: rootStart });
    rootSpan.setAttribute('trace.id', trace.traceId);
    rootSpan.setAttribute(OPENINFERENCE_SPAN_KIND, 'CHAIN');
    if (trace.attributes.sessionId !== undefined && trace.attributes.sessionId !== null) {
      rootSpan.setAttribute(ATTR.SESSION_ID, String(trace.attributes.sessionId));
    }
    if (trace.attributes.studentId !== undefined && trace.attributes.studentId !== null) {
      rootSpan.setAttribute(ATTR.USER_ID, String(trace.attributes.studentId));
    }
    setSafeAttributes(rootSpan, trace.attributes);
    rootSpan.setStatus({ code: trace.status === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });

    const rootCtx = otelTrace.setSpan(otelContext.active(), rootSpan);

    // Build the real parent/child tree instead of flattening everyone under
    // root. Guards against the malformed-data cases the spec calls out:
    // missing parents (unknown parentSpanId -> attach to root), duplicate
    // spanIds (first one wins, rest logged and skipped), and cycles (a
    // `visiting` set stops any accidental infinite recursion).
    const byId = new Map<string, FinishedSpan>();
    const childrenOf = new Map<string, FinishedSpan[]>();
    for (const span of trace.spans) {
      if (byId.has(span.spanId)) {
        logger.warn(`[PHOENIX] Duplicate spanId ${span.spanId} in trace ${trace.traceId} — keeping first occurrence`);
        continue;
      }
      byId.set(span.spanId, span);
    }
    for (const span of byId.values()) {
      const parentKnown = span.parentSpanId !== trace.rootSpanId && byId.has(span.parentSpanId);
      const key = parentKnown ? span.parentSpanId : trace.rootSpanId;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key)!.push(span);
    }

    const visiting = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function emit(span: FinishedSpan, parentCtx: any): void {
      if (visiting.has(span.spanId)) {
        logger.warn(`[PHOENIX] Cycle detected at span ${span.spanId} in trace ${trace.traceId} — skipping`);
        return;
      }
      visiting.add(span.spanId);

      const childSpan = tracer.startSpan(span.name, { startTime: span.startedAt }, parentCtx);
      childSpan.setAttribute(OPENINFERENCE_SPAN_KIND, span.kind);
      setSafeAttributes(childSpan, span.metadata);
      if (span.errorCode) childSpan.setAttribute('error.code', span.errorCode);
      childSpan.setAttribute('span.status', span.status);
      if (span.statusMessage) childSpan.setAttribute('span.status_message', span.statusMessage);
      if (span.exception) {
        // tracer.ts intentionally keeps the raw err.message in-process (for
        // server logs/debugging — see its own comment there); this is the
        // export boundary that must not forward it unredacted, since a
        // thrown validation/library error can echo request content (e.g. a
        // student's question) straight into its message. recordException()
        // is OTel's own API and bypasses setSafeAttributes entirely, so it
        // needs its own explicit sanitize call rather than inheriting one.
        const message = isContentCaptureEnabled()
          ? (sanitizeValue(span.exception.message) as string)
          : `[content capture disabled] ${span.exception.errorCode}`;
        childSpan.recordException({ name: span.exception.errorCode, message, stack: span.exception.stack });
      }
      for (const evt of span.events) {
        childSpan.addEvent(evt.name, evt.attributes ? (sanitizeAttributes(evt.attributes) as Record<string, string | number | boolean>) : undefined, evt.timestamp);
      }
      childSpan.setStatus({ code: span.status === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });

      const childCtx = otelTrace.setSpan(otelContext.active(), childSpan);
      const nestedCtx = otelContext.with(childCtx, () => childCtx); // context object itself, no execution needed
      for (const child of childrenOf.get(span.spanId) ?? []) {
        emit(child, nestedCtx);
      }

      childSpan.end(span.startedAt + span.durationMs);
      visiting.delete(span.spanId);
    }

    for (const rootChild of childrenOf.get(trace.rootSpanId) ?? []) {
      emit(rootChild, rootCtx);
    }

    rootSpan.end(rootEnd);
  } catch (err) {
    logger.warn(`[PHOENIX] Trace export failed (non-fatal): ${(err as Error).message}`);
  }
}
