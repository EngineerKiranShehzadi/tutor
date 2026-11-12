import { Router } from 'express';
import { listPersonalCourses, addPersonalCourse, removePersonalCourse, validatePersonalCourseId } from '../services/student-youtube-course.service';
import { listSavedPlaylists, savePlaylist, removeSavedPlaylist } from '../services/saved-playlists.service';
import { enqueueImport, getImportJob, retryImport, runImport } from '../services/youtube-import.service';
import { AppError } from '../middleware/errorHandler';
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



// Admin-only experimental import. Student Add to My Courses requires private
// enrollment/authorization and is intentionally NOT exposed in this pilot.
router.post('/imports', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const courseId = req.body?.courseId;
    const playlistId = req.body?.playlistId;
    if (!Number.isSafeInteger(courseId) || typeof playlistId !== 'string')
      throw new AppError('courseId and playlistId are required', 400);
    const job = await enqueueImport(courseId, playlistId, req.user!.id);
    res.status(202).json({ success: true, message: 'Pilot import queued', data: { job } });
    void runImport(Number(job.id));
  } catch (e) { next(e); }
});
router.get('/imports/:jobId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { sendSuccess(res, 'Pilot import status', await getImportJob(Number(req.params.jobId), req.user!.id)); }
  catch(e) { next(e); }
});
router.post('/imports/:jobId/retry', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const job = await retryImport(Number(req.params.jobId), req.user!.id);
    res.status(202).json({ success: true, message: 'Pilot retry queued', data: { job } });
    void runImport(Number(job.id));
  } catch(e) { next(e); }
});


router.get('/saved', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { sendSuccess(res, 'My saved playlists', { playlists: await listSavedPlaylists(req.user!.id) }); }
  catch (e) { next(e); }
});
router.post('/saved', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (typeof req.body?.playlistId !== 'string') throw new AppError('playlistId required', 400);
    sendSuccess(res, 'Playlist saved', { playlist: await savePlaylist(req.user!.id, req.body.playlistId) }, 201);
  } catch (e) { next(e); }
});
router.delete('/saved/:playlistId', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await removeSavedPlaylist(req.user!.id, req.params.playlistId);
    sendSuccess(res, 'Playlist removed');
  } catch (e) { next(e); }
});

router.get('/my-courses', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try { sendSuccess(res, 'My personal YouTube courses', { courses: await listPersonalCourses(req.user!.id) }); }
  catch (e) { next(e); }
});
router.post('/my-courses', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (typeof req.body?.playlistId !== 'string') throw new AppError('playlistId required', 400);
    const course = await addPersonalCourse(req.user!.id,req.body.playlistId);
    sendSuccess(res, 'Playlist added to My Courses (preview only)', { course }, 201);
  } catch(e) { next(e); }
});
router.delete('/my-courses/:id', requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await removePersonalCourse(req.user!.id,validatePersonalCourseId(req.params.id));
    sendSuccess(res,'Personal course removed');
  } catch(e) { next(e); }
});
export default router;

