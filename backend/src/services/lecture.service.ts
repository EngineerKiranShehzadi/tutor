import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { Lecture } from '../types';
import { logger } from '../utils/logger';

// ── HELPERS ────────────────────────────────────────────────────
function extractVideoId(youtubeUrl: string): string | null {
  try {
    const url = new URL(youtubeUrl);
    // youtube.com/watch?v=ID
    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v');
    }
    // youtu.be/ID
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

function validateYoutubeUrl(url: string): string {
  const videoId = extractVideoId(url);
  if (!videoId) throw new AppError('Invalid YouTube URL. Use youtube.com/watch?v=ID or youtu.be/ID format.', 400);
  return videoId;
}

// ── CREATE ─────────────────────────────────────────────────────
export const createLecture = async (input: {
  title: string;
  description?: string;
  youtubeUrl: string;
}): Promise<Lecture> => {
  const { title, description, youtubeUrl } = input;
  if (!title.trim()) throw new AppError('Lecture title is required', 400);

  const videoId = validateYoutubeUrl(youtubeUrl);

  const { rows } = await query<Lecture>(
    `INSERT INTO lectures (title, description, youtube_url, youtube_video_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [title.trim(), description?.trim() ?? null, youtubeUrl.trim(), videoId]
  );

  const lecture = rows[0];
  logger.info(`[LECTURE] ✅ Created lecture #${lecture.id}: "${lecture.title}" (videoId=${videoId})`);
  return lecture;
};

// ── GET ALL ────────────────────────────────────────────────────
export const getLectures = async (): Promise<Lecture[]> => {
  const { rows } = await query<Lecture>('SELECT * FROM lectures ORDER BY created_at DESC');
  logger.info(`[LECTURE] Fetched ${rows.length} lecture(s)`);
  return rows;
};

// ── GET ONE ────────────────────────────────────────────────────
export const getLectureById = async (id: number): Promise<Lecture> => {
  const { rows } = await query<Lecture>('SELECT * FROM lectures WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError(`Lecture #${id} not found`, 404);
  return rows[0];
};

// ── UPDATE ─────────────────────────────────────────────────────
export const updateLecture = async (
  id: number,
  input: { title?: string; description?: string; youtubeUrl?: string }
): Promise<Lecture> => {
  const existing = await getLectureById(id);

  const title       = input.title?.trim()       ?? existing.title;
  const description = input.description?.trim()  ?? existing.description;
  const youtubeUrl  = input.youtubeUrl?.trim()   ?? existing.youtube_url;
  const videoId     = input.youtubeUrl ? validateYoutubeUrl(youtubeUrl) : existing.youtube_video_id;

  const { rows } = await query<Lecture>(
    `UPDATE lectures
     SET title = $1, description = $2, youtube_url = $3, youtube_video_id = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [title, description, youtubeUrl, videoId, id]
  );

  logger.info(`[LECTURE] ✅ Updated lecture #${id}`);
  return rows[0];
};

// ── DELETE ─────────────────────────────────────────────────────
export const deleteLecture = async (id: number): Promise<boolean> => {
  const { rowCount } = await query('DELETE FROM lectures WHERE id = $1', [id]);
  if (!rowCount) throw new AppError(`Lecture #${id} not found`, 404);
  logger.info(`[LECTURE] 🗑️  Deleted lecture #${id}`);
  return true;
};

// ── UPDATE STATUS (internal use by dataset pipeline) ───────────
export const updateLectureStatus = async (
  id: number,
  status: Lecture['status'],
  errorMsg?: string
): Promise<void> => {
  await query('UPDATE lectures SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
  if (status === 'FAILED') {
    logger.error(`[LECTURE] ❌ Lecture #${id} status → FAILED${errorMsg ? ': ' + errorMsg : ''}`);
  } else {
    logger.info(`[LECTURE] Lecture #${id} status → ${status}`);
  }
};
