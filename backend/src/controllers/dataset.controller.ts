import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { getLectureById, updateLectureStatus, updateLectureDatasetLocation } from '../services/lecture.service';
import { parseExcel, processDataset } from '../services/chunk.service';
import { uploadRawDataset, isS3Configured } from '../services/s3-storage.service';
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

    // Archive the raw file exactly as uploaded, before any parsing/chunking
    // touches it. Awaited (not fire-and-forget): if raw storage fails, the
    // upload fails — the whole point is to never lose the original source
    // file, so processing must not silently proceed without it.
    // Skipped when S3 isn't configured (local/free-tier testing); once a
    // bucket is set, a failed write still fails the upload.
    if (isS3Configured()) {
      const { bucket, key } = await uploadRawDataset(lectureId, req.file.buffer, req.file.originalname);
      await updateLectureDatasetLocation(lectureId, { bucket, key, originalFilename: req.file.originalname });
    } else {
      logger.warn(`[UPLOAD] S3 not configured — skipping raw dataset archive for lecture #${lectureId}`);
    }

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
