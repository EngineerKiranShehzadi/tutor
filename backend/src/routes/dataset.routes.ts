import { Router } from 'express';
import multer from 'multer';
import { protect, requireRole } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { supportedDatasetExtension } from '../services/document-ingestion.service';
import { uploadDataset, getDatasetVersions, rollbackDatasetVersion, exportDataset, cancelDatasetUpdate } from '../controllers/dataset.controller';

const router = Router();

// Store a single file in memory, never execute its contents. Check extension
// and browser MIME as a first gate; the actual Excel/Office/PDF parser
// validates the bytes before building a dataset. Python extractor adds
// expansion and text-size limits. Never trust MIME alone.
export const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  '',
]);

const DOCUMENT_MIME_TYPES: Record<string, Set<string>> = {
  '.pdf': new Set(['application/pdf', 'application/octet-stream', '']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream', '']),
  '.pptx': new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream', '']),
  '.txt': new Set(['text/plain', 'application/octet-stream', '']),
  '.html': new Set(['text/html', 'application/xhtml+xml', 'application/octet-stream', '']),
  '.htm': new Set(['text/html', 'application/xhtml+xml', 'application/octet-stream', '']),
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DATASET.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = supportedDatasetExtension(file.originalname);
    const mime = (file.mimetype ?? '').toLowerCase();
    const allowed = ext === '.xlsx' ? XLSX_MIME_TYPES : ext ? DOCUMENT_MIME_TYPES[ext] : undefined;
    if (allowed?.has(mime)) cb(null, true);
    else cb(new AppError('Unsupported file type. Use .xlsx, .pdf, .docx, .pptx, .txt or .html.', 400));
  },
});

// POST /api/v1/datasets/upload/:lectureId  — Admin only
router.post(
  '/upload/:lectureId',
  protect,
  requireRole('ADMIN'),
  upload.single('file'),  // frontend FormData key is 'file'
  uploadDataset
);

// GET /api/v1/datasets/versions/:lectureId  — Admin only
router.get('/versions/:lectureId', protect, requireRole('ADMIN'), getDatasetVersions);

// POST /api/v1/datasets/rollback/:lectureId — Admin only (re-activates the previous version)
router.post('/rollback/:lectureId', protect, requireRole('ADMIN'), rollbackDatasetVersion);

// POST /api/v1/datasets/cancel/:lectureId  — Admin only (stops a stuck/unwanted in-flight update)
router.post('/cancel/:lectureId', protect, requireRole('ADMIN'), cancelDatasetUpdate);

// GET /api/v1/datasets/export/:lectureId    — Admin only (active dataset incl. qa_id column)
router.get('/export/:lectureId', protect, requireRole('ADMIN'), exportDataset);

export default router;
