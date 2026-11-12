import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware';
import type { AuthenticatedRequest } from '../types';
import { sendSuccess } from '../utils/response';
import { previewPlaylist, searchPlaylists } from '../services/youtube-discovery.service';

const router = Router();
router.use(protect, requireRole('STUDENT', 'ADMIN'));

// Pilot is intentionally read-only. No course is created until the transcript
// ingestion and per-student membership path are safely integrated.
router.get('/playlists/search', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const language = typeof req.query.language === 'string' ? req.query.language : 'hi';
    sendSuccess(res, 'Playlist matches', { playlists: await searchPlaylists(query, language) });
  } catch (err) { next(err); }
});

router.get('/playlists/:playlistId/preview', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, 'Pilot playlist preview (first two videos)', {
      videos: await previewPlaylist(req.params.playlistId),
      pilotLimit: 2,
    });
  } catch (err) { next(err); }
});

export default router;
