import { Router } from 'express';
import multer from 'multer';
import { protect, requireRole } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { uploadDataset, getDatasetVersions, rollbackDatasetVersion, exportDataset, cancelDatasetUpdate } from '../controllers/dataset.controller';

const router = Router();

// Store file in memory (no disk write) — buffer passed directly to xlsx parser.
// Rejections are client errors (A16): an oversized file is a 413 and a
// non-spreadsheet a 400 (errorHandler maps multer's errors); the file's
// CONTENT is then checked by parseExcel (zip structure, size when unpacked)
// before anything parses it.
//
// The name must end in .xlsx AND the browser-reported type must be a
// spreadsheet or a generic binary type (some browsers/OSes send those for
// .xlsx). A .csv, .pdf or image renamed to .xlsx is refused here, and anything
// that is not really a workbook is refused by the content check.
export const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  '',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DATASET.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isXlsxName = file.originalname.toLowerCase().endsWith('.xlsx');
    if (isXlsxName && XLSX_MIME_TYPES.has((file.mimetype ?? '').toLowerCase())) {
      cb(null, true);
    } else {
      cb(new AppError('Only .xlsx files are allowed.', 400));
    }
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
