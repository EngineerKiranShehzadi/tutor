import { query } from '../config/database';
import { notifyAllStudents } from './notification.service';
import { AppError } from '../middleware/errorHandler';
import { Lecture } from '../types';
import { logger } from '../utils/logger';
import { defaultCourseId, getCourse } from './course.service';

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
const MAX_AGENT_INSTRUCTIONS_CHARS = 4000;

export const createLecture = async (input: {
  title: string;
  description?: string;
  youtubeUrl?: string;
  agentName: string;
  agentInstructions: string;
  courseId?: number;
}): Promise<Lecture> => {
  const { title, description, youtubeUrl } = input;
  const agentName = input.agentName?.trim() ?? '';
  const agentInstructions = input.agentInstructions?.trim() ?? '';
  if (!title.trim()) throw new AppError('Lecture title is required', 400);
  if (!agentName) throw new AppError('AI agent name is required', 400);
  if (!agentInstructions) throw new AppError('AI agent instructions are required', 400);
  // Mirrors lecture_agent_profiles_instructions_max_length (migration 005).
  if (agentInstructions.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    throw new AppError(`AI agent instructions must be at most ${MAX_AGENT_INSTRUCTIONS_CHARS} characters`, 400);
  }

  const videoId = youtubeUrl?.trim() ? validateYoutubeUrl(youtubeUrl) : null;
  const courseId = input.courseId ?? await defaultCourseId();
  await getCourse(courseId);

  // One statement, so the lecture and its agent profile are created
  // atomically — a lecture can never exist without its profile.
  const { rows } = await query<Lecture>(
    `WITH new_lecture AS (
       INSERT INTO lectures (title, description, youtube_url, youtube_video_id, course_id)
       VALUES ($1, $2, $3, $4, $7)
       RETURNING *
     ), new_profile AS (
       INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions)
       SELECT id, $5, $6 FROM new_lecture
     )
     SELECT * FROM new_lecture`,
    [title.trim(), description?.trim() ?? null, youtubeUrl?.trim() ?? '', videoId, agentName, agentInstructions, courseId]
  );

  const lecture = rows[0];
  logger.info(`[LECTURE] ✅ Created lecture #${lecture.id}: "${lecture.title}" (videoId=${videoId})`);

  // Tell every student the lecture exists. Its tutor is not ready yet — that
  // is a second notification, sent from dataset-version.service once a version
  // is activated. notifyAllStudents never throws, so a notification problem
  // cannot undo a lecture that has already been created.
  await notifyAllStudents('LECTURE_ADDED', 'New lecture added', lecture.title, lecture.id);

  return lecture;
};

// ── GET ALL ────────────────────────────────────────────────────
export const getLectures = async (courseId?: number, includeArchived = false): Promise<Lecture[]> => {
  if (courseId !== undefined) await getCourse(courseId);
  // Students and the chat read this, so archived lectures are left out unless
  // the caller is the admin list, which is where a lecture is restored.
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (courseId !== undefined) { params.push(courseId); conditions.push(`l.course_id = $${params.length}`); }
  if (!includeArchived) conditions.push('l.archived_at IS NULL');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query<Lecture>(
    `SELECT l.*, ap.agent_name FROM lectures l
     LEFT JOIN lecture_agent_profiles ap ON ap.lecture_id = l.id
     ${where}
     ORDER BY l.created_at DESC, l.id DESC`, params);
  logger.info(`[LECTURE] Fetched ${rows.length} lecture(s)`);
  return rows;
};

// ── GET ONE ────────────────────────────────────────────────────
export const getLectureById = async (id: number): Promise<Lecture> => {
  const { rows } = await query<Lecture>('SELECT l.*, ap.agent_name FROM lectures l LEFT JOIN lecture_agent_profiles ap ON ap.lecture_id = l.id WHERE l.id = $1', [id]);
  if (!rows[0]) throw new AppError(`Lecture #${id} not found`, 404);
  return rows[0];
};

// ── UPDATE ─────────────────────────────────────────────────────
export const updateLecture = async (
  id: number,
  input: { title?: string; description?: string; youtubeUrl?: string; courseId?: number }
): Promise<Lecture> => {
  const existing = await getLectureById(id);

  const title       = input.title?.trim()       ?? existing.title;
  const description = input.description?.trim()  ?? existing.description;
  const youtubeUrl  = input.youtubeUrl?.trim()   ?? existing.youtube_url;
  const videoId     = input.youtubeUrl ? validateYoutubeUrl(youtubeUrl) : existing.youtube_video_id;
  const courseId = input.courseId ?? existing.course_id;
  const target = await getCourse(courseId);
  // Moving a lecture into a withdrawn course would hide it with no sign of why.
  if (target.archived_at && courseId !== existing.course_id) {
    throw new AppError('That course has been archived. Restore it before moving a lecture into it.', 409);
  }

  const { rows } = await query<Lecture>(
    `UPDATE lectures
     SET title = $1, description = $2, youtube_url = $3, youtube_video_id = $4, course_id = $6, updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [title, description, youtubeUrl, videoId, id, courseId]
  );

  logger.info(`[LECTURE] ✅ Updated lecture #${id}`);
  return rows[0];
};

// ── DELETE ─────────────────────────────────────────────────────
/** How many questions students have asked about this lecture. */
export const lectureQuestionCount = async (id: number): Promise<number> => {
  const { rows } = await query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM student_questions WHERE lecture_id = $1', [id]);
  return rows[0]?.n ?? 0;
};

/**
 * Withdraw a lecture from students without destroying anything.
 *
 * Its dataset, its tutor profile and every question asked about it stay
 * exactly as they are; the lecture simply stops being listed and stops being
 * answerable. restoreLecture puts it back.
 */
export const archiveLecture = async (id: number): Promise<Lecture> => {
  const existing = await getLectureById(id);
  if (existing.archived_at) return existing;
  await query('UPDATE lectures SET archived_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
  logger.info(`[LECTURE] Archived lecture #${id}`);
  return getLectureById(id);
};

export const restoreLecture = async (id: number): Promise<Lecture> => {
  await getLectureById(id);
  await query('UPDATE lectures SET archived_at = NULL, updated_at = NOW() WHERE id = $1', [id]);
  logger.info(`[LECTURE] Restored lecture #${id}`);
  return getLectureById(id);
};

/**
 * Permanent removal.
 *
 * Eight tables cascade off a lecture row: its qna chunks, its dataset versions,
 * its agent profile, its chat sessions and chat history, the student questions
 * recorded against it, its notifications and its answer memory. Once a student
 * has asked about the lecture that history is the record of the system being
 * used, so deletion is refused and the lecture is archived instead. A lecture
 * nobody has asked about can still be removed outright.
 */
export const deleteLecture = async (id: number): Promise<boolean> => {
  await getLectureById(id);
  const asked = await lectureQuestionCount(id);
  if (asked > 0) {
    throw new AppError(
      `${asked} question${asked === 1 ? ' has' : 's have'} been asked about this lecture. Deleting it would remove ${asked === 1 ? 'that question' : 'them'} along with its dataset and chat history. Archive it instead.`,
      409);
  }
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

export const updateLectureProgress = async (
  id: number,
  current: number,
  total?: number
): Promise<void> => {
  if (total !== undefined) {
    await query(
      'UPDATE lectures SET progress_current = $1, progress_total = $2 WHERE id = $3',
      [current, total, id]
    );
  } else {
    await query('UPDATE lectures SET progress_current = $1 WHERE id = $2', [current, id]);
  }
};

// Records where the raw uploaded dataset file was archived in S3 (see
// services/s3-storage.service.ts) — a re-upload overwrites the pointer to
// point at the newest raw file; the older S3 object is left in place.
export const updateLectureDatasetLocation = async (
  id: number,
  location: { bucket: string; key: string; originalFilename: string }
): Promise<void> => {
  await query(
    `UPDATE lectures
     SET dataset_s3_bucket = $1, dataset_s3_key = $2, dataset_original_filename = $3, updated_at = NOW()
     WHERE id = $4`,
    [location.bucket, location.key, location.originalFilename, id]
  );
  logger.info(`[LECTURE] 📦 Lecture #${id} raw dataset archived at s3://${location.bucket}/${location.key}`);
};
