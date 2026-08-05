import { Router } from 'express';
import authRoutes    from './auth.routes';
import datasetRoutes from './dataset.routes';
import observabilityRoutes from './observability.routes';
import { logger }    from '../utils/logger';
import { checkLiveness, checkReadiness } from '../observability/health.service';

const router = Router();

router.use('/auth',     authRoutes);
router.use('/datasets', datasetRoutes);
router.use('/observability', observabilityRoutes);

// Preserved unchanged for backward compatibility — existing callers
// (uptime pings, deploy scripts) keep working exactly as before.
router.get('/health', (_req, res) => {
  logger.info('[HEALTH] ✅ Health check OK');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Lightweight — only confirms the process is alive, no dependency checks.
router.get('/health/live', (_req, res) => {
  res.json(checkLiveness());
});

// Checks every dependency required to answer a lecture question. Never
// exposes raw provider errors — only safe status/latency/error-code.
router.get('/health/ready', async (_req, res) => {
  try {
    const result = await checkReadiness();
    const httpStatus = result.status === 'unhealthy' ? 503 : 200;
    res.status(httpStatus).json(result);
  } catch (err) {
    logger.error('[HEALTH] Readiness check itself failed unexpectedly', err);
    res.status(503).json({ status: 'unhealthy', checkedAt: new Date().toISOString(), components: {} });
  }
});

export default router;
