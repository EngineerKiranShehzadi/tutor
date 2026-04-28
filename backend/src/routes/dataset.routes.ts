import { Router } from 'express';
import multer from 'multer';
import { protect, requireRole } from '../middleware/auth.middleware';
import { uploadDataset } from '../controllers/dataset.controller';

const router = Router();

// Store file in memory (no disk write) — buffer passed directly to xlsx parser
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx files are allowed'));
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

export default router;
