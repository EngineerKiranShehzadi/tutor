import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../middleware/auth.middleware';
import { AuthenticatedRequest } from '../types';
import { logger } from '../utils/logger';
import { validLectureId } from '../rag/performance/warmup';
import { requestRetrievalWarmup, retrievalWarmupEnabled } from '../services/retrieval-warmup.service';

const router = Router();
const limit = rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => (req as AuthenticatedRequest).user!.id,
  message: { status: 'RATE_LIMITED' } });
// Same authenticated access as existing lecture reads; no arbitrary SQL/index/vector input.
router.post('/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!retrievalWarmupEnabled) { res.json({ status: 'DISABLED' }); return; }
  next();
}, protect, limit, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) { res.status(401).json({ status: 'UNAUTHORIZED' }); return; }
  const id: unknown = req.body?.lectureId;
  if (!validLectureId(id)) { res.status(400).json({ status: 'INVALID_LECTURE_ID' }); return; }
  try { res.json(await requestRetrievalWarmup(id)); }
  catch {
    logger.warn(`[DB-WARMUP] lecture=${id} unavailable or budget exceeded; normal chat is unaffected`);
    res.status(503).json({ status: 'WARMUP_UNAVAILABLE' });
  }
});
export default router;
