import { Router } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware';
import { listRagTraces, getRagTraceSpans } from '../services/phoenix-query.service';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/v1/observability/rag-traces  — Admin only
router.get('/rag-traces', protect, requireRole('ADMIN'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const traces = await listRagTraces(limit);
    res.json({ traces });
  } catch (err) {
    logger.error('[OBSERVABILITY] Failed to list RAG traces', err);
    res.status(502).json({ message: 'Unable to reach Phoenix — is it running and configured?' });
  }
});

// GET /api/v1/observability/rag-traces/:traceId  — Admin only
router.get('/rag-traces/:traceId', protect, requireRole('ADMIN'), async (req, res) => {
  try {
    const spans = await getRagTraceSpans(req.params.traceId);
    res.json({ spans });
  } catch (err) {
    logger.error('[OBSERVABILITY] Failed to load trace spans', err);
    res.status(502).json({ message: 'Unable to reach Phoenix — is it running and configured?' });
  }
});

export default router;
