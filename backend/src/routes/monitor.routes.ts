import { Router, Request, Response } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { logger } from '../utils/logger';
import {
  parseWindow, getSummary, getTimeseries, getAttention, getLectureStats, getStageStats,
} from '../services/observability/monitor.service';
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
    const result = await getAttention(limit, (req.query.before as string) || null);
    res.json({ success: true, data: result.rows, meta: { nextBefore: result.nextBefore } });
  } catch (err) { fail(res, err, 'GET /attention'); }
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

export default router;
