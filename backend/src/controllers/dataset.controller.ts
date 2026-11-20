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
import { supportedDatasetExtension, runDocumentExtractor, documentToRows, applyVisualReviewDecisions } from '../services/document-ingestion.service';
import type { DocumentRowsResult } from '../services/document-ingestion.service';
import { isSubtitleExtension, subtitleToRows } from '../services/subtitle-ingestion.service';

const parseLectureId = (req: AuthenticatedRequest): number => parseInt(req.params['lectureId'] ?? '', 10);

const isDocumentRowsResult = (value: unknown): value is DocumentRowsResult => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const quality = candidate.quality;
  if (!quality || typeof quality !== 'object') return false;
  const report = quality as Record<string, unknown>;
  return Array.isArray(candidate.rows) && Array.isArray(candidate.warnings) &&
    typeof candidate.units === 'number' && Array.isArray(candidate.visualReviewPages) &&
    typeof report.outputRecords === 'number' && typeof report.proseRecords === 'number';
};

// POST /datasets/upload/:lectureId   multipart: xlsx/pdf/docx/pptx/txt/html, [mode=MERGE|REPLACE], [confirmRemovals=<n>], [dryRun=true]
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
    sendError(res, 'No file uploaded. Attach an .xlsx, .pdf, .docx, .ppt, .pptx, .txt, .html, .srt or .vtt file.', 400);
    return;
  }

  const extension = supportedDatasetExtension(req.file.originalname);
  if (!extension) {
    sendError(res, 'Supported formats: .xlsx, .pdf, .docx, .ppt, .pptx, .txt, .html, .htm, .srt, .vtt', 400);
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

    const document = extension === '.xlsx'
      ? null
      : isSubtitleExtension(extension)
        ? subtitleToRows(file.originalname, file.buffer, extension)
        : await documentToRows(file.originalname, await runDocumentExtractor(file.buffer, extension));
    // Subtitle rows do not carry visual review metadata; document rows do.
    const documentRows = isDocumentRowsResult(document) ? document : null;
    const visualReviewPages = documentRows?.visualReviewPages ?? [];
    let visualReviewDecisions: Record<string, { include: boolean; reviewed: boolean }> = {};
    if (body['visualReviewDecisions']) {
      try {
        const parsed = JSON.parse(body['visualReviewDecisions']);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.values(parsed).some((value: any) => !value || typeof value.include !== 'boolean' || typeof value.reviewed !== 'boolean')) {
          throw new Error('Invalid visual review decisions');
        }
        visualReviewDecisions = parsed;
      } catch {
        sendError(res, 'Visual review decisions are invalid. Reanalyse the document and try again.', 400);
        return;
      }
    }
    const manualVisualReviewRequired = !!document?.warnings.some(warning => warning.startsWith('Visual review required:')) && visualReviewPages.length === 0;
    if (!dryRun && visualReviewPages.some(page => visualReviewDecisions[page.locator]?.reviewed !== true)) {
      sendError(res, 'Review every visual candidate and choose include or exclude before applying this dataset.', 422);
      return;
    }
    if (!dryRun && manualVisualReviewRequired && body['confirmVisualReview'] !== 'true') {
      sendError(res, 'Review the original document pages and confirm before applying this dataset.', 422);
      return;
    }
    let effectiveRows = document?.rows;
    if (document && visualReviewPages.length) {
      const safeName = file.originalname.replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 180);
      effectiveRows = applyVisualReviewDecisions(document.rows, visualReviewPages, visualReviewDecisions, safeName);
    }
    const effectiveDocumentQuality = documentRows
      ? { ...documentRows.quality,
          outputRecords: effectiveRows?.length ?? documentRows.quality.outputRecords,
          proseRecords: effectiveRows?.filter(row => typeof row.question === 'string' && row.question.startsWith('Source excerpt:')).length ?? documentRows.quality.proseRecords }
      : null;
    const result = await prepareDatasetVersion(lectureId, file.buffer, {
      mode, dryRun, confirmRemovals, filename: file.originalname,
      ...(document ? { rawRows: effectiveRows } : {}),
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
      sendSuccess(res, 'Dry run — nothing was changed.', { lectureId, preview: result.preview, previews: result.previews, extractionWarnings: document?.warnings ?? [], documentQuality: effectiveDocumentQuality, visualReviewPages, previewRows: document && dryRun ? (effectiveRows ?? document.rows).map((row, index) => ({ index: index + 1, question: row.question, answer: row.answer, topic: row.topic, source: row.start_time })) : undefined });
      return;
    }
    if (result.kind === 'NOOP') {
      sendSuccess(res, 'The uploaded file matches the active dataset — nothing to update.', { lectureId, preview: result.preview, extractionWarnings: document?.warnings ?? [], documentQuality: effectiveDocumentQuality });
      return;
    }

    if (archive.location) await updateLectureDatasetLocation(lectureId, archive.location);
    // The new version's real state, as the build wrote it (finishDatasetVersion
    // only starts below); the lecture's own status is not reported (it stays
    // READY when a dataset is live, EMBEDDING for a first upload).
    sendSuccess(res, 'Dataset uploaded. Building the new version in the background; the current dataset stays live until it is complete.', {
      lectureId, versionStatus: result.versionStatus, versionId: result.versionId, versionNo: result.versionNo, preview: result.preview, extractionWarnings: document?.warnings ?? [], documentQuality: effectiveDocumentQuality,
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
    if (err instanceof AppError) {
      logger.error(`[UPLOAD] ❌ Lecture #${lectureId}: ${err.message}`);
      sendError(res, err.message, err.statusCode);
      return;
    }
    // Every problem with the file itself is an AppError (400/409/413). Anything
    // else — the database, S3, a bug — is the server failing, not a bad file:
    // the shared handler answers 500 and logs it content-safely (A18). This
    // line only names the lecture and the error type, never the message.
    logger.error(`[UPLOAD] ❌ Lecture #${lectureId}: server fault during upload (${(err as Error)?.name ?? 'Error'}) — see the error log entry that follows`);
    next(err);
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
