import { Router } from 'express';
import authRoutes    from './auth.routes';
import datasetRoutes from './dataset.routes';
import { logger }    from '../utils/logger';

const router = Router();

router.use('/auth',     authRoutes);
router.use('/datasets', datasetRoutes);

router.get('/health', (_req, res) => {
  logger.info('[HEALTH] ✅ Health check OK');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
