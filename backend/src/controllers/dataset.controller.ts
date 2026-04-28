import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { getLectureById, updateLectureStatus } from '../services/lecture.service';
import { parseExcel, processDataset } from '../services/chunk.service';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../utils/logger';

export const uploadDataset = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const lectureId = parseInt(req.params['lectureId'] ?? '', 10);

  if (isNaN(lectureId)) {
    sendError(res, 'Invalid lecture ID', 400);
    return;
  }

  if (!req.file) {
    sendError(res, 'No file uploaded. Please attach an .xlsx file.', 400);
    return;
  }

  // Only accept .xlsx
  const originalName = req.file.originalname.toLowerCase();
  if (!originalName.endsWith('.xlsx')) {
    sendError(res, 'Invalid file type. Only .xlsx files are accepted.', 400);
    return;
  }

  try {
    // Verify lecture exists
    const lecture = await getLectureById(lectureId);

    // Quick parse validation before long async job (returns fast errors)
    parseExcel(req.file.buffer);

    logger.info(`[UPLOAD] Admin "${req.user?.email}" uploading dataset for lecture #${lectureId} "${lecture.title}"`);

    // Update to DATASET_UPLOADED immediately so the response is fast
    await updateLectureStatus(lectureId, 'DATASET_UPLOADED');
    sendSuccess(res, 'Dataset uploaded. Processing started in background.', { lectureId, status: 'PROCESSING' });

    // Process asynchronously so HTTP response is already sent
    processDataset(lectureId, req.file.buffer).catch(err => {
      logger.error(`[UPLOAD] ❌ Background processing failed for lecture #${lectureId}:`, err);
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error(`[UPLOAD] ❌ ${msg}`);
    sendError(res, msg, 400);
    next(err);
  }
};
