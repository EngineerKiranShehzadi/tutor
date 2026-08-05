import { Router, Request, Response } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getPhoenixCapabilities } from '../services/observability/capabilities';
import { computeOverview } from '../services/observability/aggregate.service';
import { listTraces, getTraceDetail } from '../services/observability/traces.service';
import { listSpans, getSpanDetail } from '../services/observability/spans.service';
import { listAllSessions, getSessionDetail } from '../services/observability/sessions.service';
import {
  addAdminSpanNote, addAdminTraceNote, addAdminSessionNote,
  addAdminSpanAnnotation, addAdminTraceAnnotation, addAdminSessionAnnotation,
} from '../services/observability/annotations.service';
import { isObservabilityError, ObservabilityError } from '../services/observability/errors';
import type { AuthenticatedRequest } from '../types';
import {
  overviewValidators, traceListValidators, traceIdParamValidators,
  spanListValidators, spanIdParamValidators, sessionListValidators, sessionIdParamValidators,
  createNoteValidators, createAnnotationValidators,
} from '../validation/observability.schema';

const router = Router();

// Every route below is admin-only. The browser never talks to Phoenix
// directly — PHOENIX_BASE_URL/PHOENIX_API_KEY never leave this process.
router.use(protect, requireRole('ADMIN'));

let lastSuccessfulQueryAt: string | null = null;
let lastRecentError: string | null = null;

function markSuccess(): void {
  lastSuccessfulQueryAt = new Date().toISOString();
  lastRecentError = null;
}

function handleError(res: Response, err: unknown, routeLabel: string): void {
  const e = isObservabilityError(err) ? err : new ObservabilityError('PHOENIX_UNREACHABLE', 'Unexpected observability query failure');
  lastRecentError = `${e.code}: ${e.message}`.slice(0, 300);
  logger.warn(`[OBSERVABILITY-API] ${routeLabel} failed: code=${e.code} message=${e.message}`);
  res.status(e.statusCode).json({ success: false, code: e.code, message: e.message });
}

function safeEndpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '(unset)';
  }
}

// ── 1. Configuration and health ─────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  const caps = await getPhoenixCapabilities();
  res.json({
    success: true,
    data: {
      observabilityEnabled: env.OBSERVABILITY.ENABLED,
      phoenixEnabled: env.OBSERVABILITY.PHOENIX_ENABLED,
      phoenixReachable: caps.reachable,
      projectName: env.OBSERVABILITY.PHOENIX_PROJECT_NAME,
      serverVersion: caps.serverVersion,
      lastSuccessfulQueryAt,
      endpointLabel: safeEndpointLabel(env.OBSERVABILITY.PHOENIX_BASE_URL),
      samplingRate: env.OBSERVABILITY.SAMPLE_RATE,
      contentCaptureEnabled: env.OBSERVABILITY.CAPTURE_CONTENT,
      recentErrorMessage: lastRecentError,
    },
  });
});

router.get('/capabilities', async (_req: Request, res: Response) => {
  const caps = await getPhoenixCapabilities();
  res.json({ success: true, data: caps });
});

// ── 2. Overview ───────────────────────────────────────────────────────

router.get('/overview', overviewValidators, validate, async (req: Request, res: Response) => {
  try {
    const result = await computeOverview({
      startTime: req.query.startTime as string | undefined,
      endTime: req.query.endTime as string | undefined,
      lectureId: req.query.lectureId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      route: req.query.route as string | undefined,
      status: req.query.status as string | undefined,
      environment: req.query.environment as string | undefined,
    });
    markSuccess();
    res.json({ success: true, data: result.metrics, meta: { coveredTraceCount: result.coveredTraceCount, truncated: result.truncated } });
  } catch (err) {
    handleError(res, err, 'GET /overview');
  }
});

// Narrow drill-down slices of the same overview computation — reuse the
// short-lived cache in aggregate.service.ts instead of issuing a second
// Phoenix read per widget.
const METRIC_SLICES: Record<string, (m: Awaited<ReturnType<typeof computeOverview>>['metrics']) => unknown> = {
  latency: m => m.latencyMs,
  tokens: m => m.tokens,
  errors: m => ({ errorRate: m.errorRate, failedTraces: m.failedTraces, mostFrequentErrors: m.mostFrequentErrors }),
  routes: m => m.routeDistribution,
  models: m => m.modelDistribution,
  retrieval: m => ({ retrievalCallCount: m.retrievalCallCount, zeroRetrievalCount: m.zeroRetrievalCount, rerankerCallCount: m.rerankerCallCount }),
  memory: m => m.memory,
  fallback: m => ({ count: m.fallbackCount, breakdown: m.fallbackBreakdown }),
};

router.get('/metrics/:slice', overviewValidators, validate, async (req: Request, res: Response) => {
  // req.params.slice is a plain string from the URL, never validated
  // against an enum — a bare `METRIC_SLICES[req.params.slice]` lookup
  // would resolve prototype-chain keys like "constructor" or
  // "__proto__" (Object.prototype members are truthy/exist), bypassing
  // the intended 404-on-unknown-slice check below. hasOwnProperty
  // restricts the lookup to slice's own enumerable keys only.
  const slice = Object.prototype.hasOwnProperty.call(METRIC_SLICES, req.params.slice)
    ? METRIC_SLICES[req.params.slice]
    : undefined;
  if (!slice) {
    res.status(404).json({ success: false, code: 'INVALID_OBSERVABILITY_FILTER', message: `Unknown metrics slice "${req.params.slice}"` });
    return;
  }
  try {
    const result = await computeOverview({
      startTime: req.query.startTime as string | undefined,
      endTime: req.query.endTime as string | undefined,
      lectureId: req.query.lectureId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      route: req.query.route as string | undefined,
      status: req.query.status as string | undefined,
      environment: req.query.environment as string | undefined,
    });
    markSuccess();
    res.json({ success: true, data: slice(result.metrics) });
  } catch (err) {
    handleError(res, err, `GET /metrics/${req.params.slice}`);
  }
});

// ── 3. Traces ────────────────────────────────────────────────────────

router.get('/traces', traceListValidators, validate, async (req: Request, res: Response) => {
  try {
    const result = await listTraces({
      cursor: (req.query.cursor as string) || null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      startTime: req.query.startTime as string | undefined,
      endTime: req.query.endTime as string | undefined,
      search: req.query.search as string | undefined,
      traceId: req.query.traceId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      lectureId: req.query.lectureId as string | undefined,
      userId: req.query.userId as string | undefined,
      route: req.query.route as string | undefined,
      status: req.query.status as string | undefined,
      spanKind: req.query.spanKind as string | undefined,
      spanName: req.query.spanName as string | undefined,
      model: req.query.model as string | undefined,
      minLatencyMs: req.query.minLatencyMs ? Number(req.query.minLatencyMs) : undefined,
      maxLatencyMs: req.query.maxLatencyMs ? Number(req.query.maxLatencyMs) : undefined,
      memoryResult: req.query.memoryResult as string | undefined,
      errorOnly: req.query.errorOnly === 'true',
      sort: (req.query.sort as 'start_time' | 'latency_ms') || undefined,
      order: (req.query.order as 'asc' | 'desc') || undefined,
    });
    markSuccess();
    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'GET /traces');
  }
});

router.get('/traces/:traceId', traceIdParamValidators, validate, async (req: Request, res: Response) => {
  try {
    const detail = await getTraceDetail(req.params.traceId);
    markSuccess();
    res.json({ success: true, data: detail });
  } catch (err) {
    handleError(res, err, 'GET /traces/:traceId');
  }
});

router.post('/traces/:traceId/notes', traceIdParamValidators, createNoteValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminTraceNote(req.params.traceId, req.body.note);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /traces/:traceId/notes');
  }
});

router.post('/traces/:traceId/annotations', traceIdParamValidators, createAnnotationValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminTraceAnnotation(req.params.traceId, req.body.name, req.body.label ?? null, req.body.score ?? null, req.user!.email);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /traces/:traceId/annotations');
  }
});

// ── 4. Spans ─────────────────────────────────────────────────────────

router.get('/spans', spanListValidators, validate, async (req: Request, res: Response) => {
  try {
    const result = await listSpans({
      cursor: (req.query.cursor as string) || null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      traceIds: req.query.traceIds ? String(req.query.traceIds).split(',').map(s => s.trim()).filter(Boolean) : undefined,
      parentId: req.query.parentId as string | undefined,
      name: req.query.name as string | undefined,
      spanKind: req.query.spanKind as string | undefined,
      status: req.query.status as string | undefined,
      startTime: req.query.startTime as string | undefined,
      endTime: req.query.endTime as string | undefined,
      minLatencyMs: req.query.minLatencyMs ? Number(req.query.minLatencyMs) : undefined,
      maxLatencyMs: req.query.maxLatencyMs ? Number(req.query.maxLatencyMs) : undefined,
      search: req.query.search as string | undefined,
      model: req.query.model as string | undefined,
    });
    markSuccess();
    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'GET /spans');
  }
});

router.get('/spans/:spanId', spanIdParamValidators, validate, async (req: Request, res: Response) => {
  try {
    const result = await getSpanDetail(req.params.spanId);
    if (!result) {
      res.status(404).json({ success: false, code: 'SPAN_NOT_FOUND', message: `Span ${req.params.spanId} not found` });
      return;
    }
    markSuccess();
    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'GET /spans/:spanId');
  }
});

router.post('/spans/:spanId/notes', spanIdParamValidators, createNoteValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminSpanNote(req.params.spanId, req.body.note);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /spans/:spanId/notes');
  }
});

router.post('/spans/:spanId/annotations', spanIdParamValidators, createAnnotationValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminSpanAnnotation(req.params.spanId, req.body.name, req.body.label ?? null, req.body.score ?? null, req.user!.email);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /spans/:spanId/annotations');
  }
});

// ── 5. Sessions ──────────────────────────────────────────────────────

router.get('/sessions', sessionListValidators, validate, async (req: Request, res: Response) => {
  try {
    const result = await listAllSessions(
      req.query.limit ? Number(req.query.limit) : undefined,
      (req.query.cursor as string) || null
    );
    markSuccess();
    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'GET /sessions');
  }
});

router.get('/sessions/:sessionId', sessionIdParamValidators, validate, async (req: Request, res: Response) => {
  try {
    const detail = await getSessionDetail(req.params.sessionId);
    markSuccess();
    res.json({ success: true, data: detail });
  } catch (err) {
    handleError(res, err, 'GET /sessions/:sessionId');
  }
});

router.post('/sessions/:sessionId/notes', sessionIdParamValidators, createNoteValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminSessionNote(req.params.sessionId, req.body.note);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /sessions/:sessionId/notes');
  }
});

router.post('/sessions/:sessionId/annotations', sessionIdParamValidators, createAnnotationValidators, validate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await addAdminSessionAnnotation(req.params.sessionId, req.body.name, req.body.label ?? null, req.body.score ?? null, req.user!.email);
    markSuccess();
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    handleError(res, err, 'POST /sessions/:sessionId/annotations');
  }
});

export default router;
