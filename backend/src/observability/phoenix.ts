import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { FinishedTrace } from './types';

// Optional, best-effort export of our own internal traces to Phoenix over
// OTLP. Fully inert unless both OBSERVABILITY_ENABLED and PHOENIX_ENABLED
// are true — the OpenTelemetry SDK is never even initialized otherwise, so
// a missing/unreachable Phoenix instance can never affect a student
// request. Our own in-process tracer (tracer.ts) is the source of truth;
// this is a one-way side channel for developer-level trace inspection.

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

    const exporter = new OTLPTraceExporter({ url: env.OBSERVABILITY.PHOENIX_ENDPOINT });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'askaitutor-backend',
        // Phoenix groups traces into "projects" by this resource attribute.
        // Setting it explicitly lets phoenix-query.service.ts read traces
        // back from a known project name instead of relying on "default".
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
    for (const [key, value] of Object.entries(trace.attributes)) {
      if (value !== undefined && value !== null) rootSpan.setAttribute(key, value as string | number | boolean);
    }
    rootSpan.setStatus({ code: trace.status === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });

    const parentCtx = otelTrace.setSpan(otelContext.active(), rootSpan);
    for (const span of trace.spans) {
      const childSpan = tracer.startSpan(span.name, { startTime: span.startedAt }, parentCtx);
      for (const [key, value] of Object.entries(span.metadata)) {
        if (value !== undefined && value !== null) childSpan.setAttribute(key, value as string | number | boolean);
      }
      if (span.errorCode) childSpan.setAttribute('error.code', span.errorCode);
      childSpan.setAttribute('span.status', span.status);
      childSpan.setStatus({ code: span.status === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      childSpan.end(span.startedAt + span.durationMs);
    }

    rootSpan.end(rootEnd);
  } catch (err) {
    logger.warn(`[PHOENIX] Trace export failed (non-fatal): ${(err as Error).message}`);
  }
}
