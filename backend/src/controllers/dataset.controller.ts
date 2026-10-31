import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { getLectureById, updateLectureDatasetLocation } from '../services/lecture.service';
import { AppError } from '../middleware/errorHandler';
import {
  prepareDatasetVersion, finishDatasetVersion, rollbackDataset, listDatasetVersions, exportActiveDataset,
  cancelDatasetBuild, RemovalConfirmationRequired, DatasetMode,
} from '../services/dataset-version.service';
import { uploadRawDataset, isS3Configured } from '../services/s3-storage.service';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../utils/logger';

const parseLectureId = (req: AuthenticatedRequest): number => parseInt(req.params['lectureId'] ?? '', 10);

// POST /datasets/upload/:lectureId   multipart: file, [mode=MERGE|REPLACE], [confirmRemovals=<n>], [dryRun=true]
//
// The uploaded file is planned against the lecture's active dataset first
// (validation, ambiguity checks, what would be added / updated / removed). Only
// then is anything written, and the new version is built next to the live one:
// the lecture keeps answering from its current dataset until the new version is
// fully embedded and validated.
export const uploadDataset = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const lectureId = parseLectureId(req);

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

  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const mode = (body['mode'] ?? 'MERGE').toUpperCase() as DatasetMode;
  const dryRun = body['dryRun'] === 'true';
  const confirmRemovals = body['confirmRemovals'] !== undefined && body['confirmRemovals'] !== ''
    ? parseInt(body['confirmRemovals'], 10)
    : undefined;
  if (mode !== 'MERGE' && mode !== 'REPLACE') {
    sendError(res, 'mode must be MERGE or REPLACE', 400);
    return;
  }

  try {
    // Verify lecture exists
    const lecture = await getLectureById(lectureId);
    const file = req.file;
    // Where the raw file was archived. The lecture only points at it once the
    // build has actually been accepted (CREATED): a refused build (409 —
    // concurrent change, or another update in flight) must not leave the
    // lecture naming a file that was never applied.
    const archive: { location: { bucket: string; key: string; originalFilename: string } | null } = { location: null };

    logger.info(`[UPLOAD] Admin "${req.user?.email}" uploading dataset for lecture #${lectureId} "${lecture.title}" (mode=${mode}${dryRun ? ', dry run' : ''})`);

    const result = await prepareDatasetVersion(lectureId, file.buffer, {
      mode, dryRun, confirmRemovals, filename: file.originalname,
      // Runs once the upload is known to be valid and just before anything is
      // written. Archive the raw file exactly as uploaded, before any parsing/
      // chunking touches it. Awaited (not fire-and-forget): if raw storage
      // fails, the upload fails — the whole point is to never lose the
      // original source file. Skipped when S3 isn't configured (local/free-tier
      // testing); once a bucket is set, a failed write still fails the upload.
      beforeBuild: async ({ firstVersion }) => {
        if (isS3Configured()) {
          const { bucket, key } = await uploadRawDataset(lectureId, file.buffer, file.originalname);
          archive.location = { bucket, key, originalFilename: file.originalname };
        } else {
          logger.warn(`[UPLOAD] S3 not configured — skipping raw dataset archive for lecture #${lectureId}`);
        }
        // No lecture status change here: this runs outside the build
        // transaction, so a write here could race another admin's upload (A8).
        // buildVersion sets a first-ever lecture to EMBEDDING inside its
        // transaction; a lecture that already has a dataset stays READY.
        void firstVersion;
      },
    });

    if (result.kind === 'DRY_RUN') {
      sendSuccess(res, 'Dry run — nothing was changed.', { lectureId, preview: result.preview });
      return;
    }
    if (result.kind === 'NOOP') {
      sendSuccess(res, 'The uploaded file matches the active dataset — nothing to update.', { lectureId, preview: result.preview });
      return;
    }

    if (archive.location) await updateLectureDatasetLocation(lectureId, archive.location);
    sendSuccess(res, 'Dataset uploaded. Building the new version in the background; the current dataset stays live until it is complete.', {
      lectureId, status: 'PROCESSING', versionId: result.versionId, versionNo: result.versionNo, preview: result.preview,
    });

    // Embed + validate + publish asynchronously so the HTTP response is already sent
    finishDatasetVersion(result.versionId).catch(err => {
      logger.error(`[UPLOAD] ❌ Background processing failed for lecture #${lectureId}:`, err);
    });

  } catch (err: unknown) {
    if (err instanceof RemovalConfirmationRequired) {
      logger.warn(`[UPLOAD] ⚠️  Lecture #${lectureId}: REPLACE needs confirmation — would remove ${err.preview.removed} Q&A(s)`);
      res.status(409).json({ success: false, message: err.message, data: { lectureId, preview: err.preview } });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Upload failed';
    logger.error(`[UPLOAD] ❌ ${msg}`);
    const status = err instanceof AppError ? err.statusCode : 400;
    sendError(res, msg, status);
  }
};

// GET /datasets/versions/:lectureId
export const getDatasetVersions = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const lectureId = parseLectureId(req);
  if (isNaN(lectureId)) { sendError(res, 'Invalid lecture ID', 400); return; }
  try {
    await getLectureById(lectureId);
    sendSuccess(res, 'Dataset versions', { lectureId, versions: await listDatasetVersions(lectureId) });
  } catch (err) { next(err); }
};

// POST /datasets/rollback/:lectureId
export const rollbackDatasetVersion = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const lectureId = parseLectureId(req);
  if (isNaN(lectureId)) { sendError(res, 'Invalid lecture ID', 400); return; }
  try {
    const result = await rollbackDataset(lectureId);
    sendSuccess(res, 'Rolled back to the previous dataset version.', { lectureId, ...result });
  } catch (err) { next(err); }
};

// POST /datasets/cancel/:lectureId — stop the in-flight update (the live dataset is untouched)
export const cancelDatasetUpdate = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const lectureId = parseLectureId(req);
  if (isNaN(lectureId)) { sendError(res, 'Invalid lecture ID', 400); return; }
  try {
    await getLectureById(lectureId);
    const result = await cancelDatasetBuild(lectureId);
    logger.warn(`[UPLOAD] Admin "${req.user?.email}" cancelled dataset update v${result.versionNo} for lecture #${lectureId}`);
    sendSuccess(res, `Update to version ${result.versionNo} was cancelled. The current dataset stays live.`, { lectureId, ...result });
  } catch (err) { next(err); }
};

// GET /datasets/export/:lectureId — the active dataset as .xlsx, including each Q&A's qa_id
export const exportDataset = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const lectureId = parseLectureId(req);
  if (isNaN(lectureId)) { sendError(res, 'Invalid lecture ID', 400); return; }
  try {
    const buf = await exportActiveDataset(lectureId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="lecture-${lectureId}-dataset.xlsx"`);
    res.send(buf);
  } catch (err) { next(err); }
};
