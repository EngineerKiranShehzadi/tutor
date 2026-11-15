import { Router, Request, Response } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { logger } from '../utils/logger';
import {
  parseWindow, getSummary, getTimeseries, getAttention, attachPhoenixLinks, getLectureStats, getStageStats,
  getFailureGroups,
} from '../services/observability/monitor.service';
import { getHealthHistory } from '../observability/health-history.service';
import { monitorWindowValidators, monitorAttentionValidators } from '../validation/observability.schema';

const router = Router();

// Admin-only, same guard as observability.routes.ts. Reads Postgres only,
// so every route works with Phoenix disabled or down.
router.use(protect, requireRole('ADMIN'));

function fail(res: Response, err: unknown, label: string): void {
  logger.error(`[MONITOR-API] ${label} failed`, err);
  res.status(500).json({ success: false, code: 'MONITOR_QUERY_FAILED', message: 'Failed to read request log' });
}

router.get('/summary', monitorWindowValidators, validate, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getSummary(parseWindow(req.query.window)) });
  } catch (err) { fail(res, err, 'GET /summary'); }
});

router.get('/timeseries', monitorWindowValidators, validate, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getTimeseries(parseWindow(req.query.window)) });
  } catch (err) { fail(res, err, 'GET /timeseries'); }
});

router.get('/attention', monitorAttentionValidators, validate, async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const result = await getAttention(limit, (req.query.before as string) || null, parseWindow(req.query.window));
    res.json({ success: true, data: await attachPhoenixLinks(result.rows), meta: { nextBefore: result.nextBefore } });
  } catch (err) { fail(res, err, 'GET /attention'); }
});

// The admin page's failure list: distinct problems with a count, rather than
// one row per request.
router.get('/failures', monitorWindowValidators, validate, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getFailureGroups(parseWindow(req.query.window)) });
  } catch (err) { fail(res, err, 'GET /failures'); }
});

router.get('/lectures', monitorWindowValidators, validate, async (req: Request, res: Response) => {
  try {
    const window = parseWindow(req.query.window);
    res.json({ success: true, data: { window, lectures: await getLectureStats(window) } });
  } catch (err) { fail(res, err, 'GET /lectures'); }
});

router.get('/stages', monitorWindowValidators, validate, async (req: Request, res: Response) => {
  try {
    const window = parseWindow(req.query.window);
    res.json({ success: true, data: { window, stages: await getStageStats(window) } });
  } catch (err) { fail(res, err, 'GET /stages'); }
});

/**
 * Uptime per dependency and when each last failed, from health_check_log.
 *
 * It lives here rather than in observability.routes.ts for two reasons: this
 * router already reads Postgres only and works with Phoenix off, which is
 * exactly what health history is; and every failure in that router is mapped
 * to an observability error code, which the page's ErrorState then renders as
 * "Tracing is not available" — the wrong message entirely for a health query.
 *
 * `hours` is clamped rather than validated with a schema: it is one optional
 * number, and the clamp is what actually matters, since an unbounded value
 * reaches make_interval() and would scan the whole table.
 */
const clampHours = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(Math.floor(n), 24 * 90);
};

router.get('/health-history', async (req: Request, res: Response) => {
  try {
    const windowHours = clampHours(req.query.hours);
    res.json({ success: true, data: { windowHours, components: await getHealthHistory(windowHours) } });
  } catch (err) { fail(res, err, 'GET /health-history'); }
});

export default router;
