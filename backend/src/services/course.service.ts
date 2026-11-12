import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';

export interface Course {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  lecture_count: number;
  ready_count: number;
}
const FIELDS = `c.id, c.title, c.subtitle, c.description, c.created_at, c.updated_at, c.archived_at,
  COUNT(l.id)::int AS lecture_count,
  COUNT(l.id) FILTER (WHERE l.status = 'READY')::int AS ready_count`;

/**
 * Active courses only, unless the caller asks for the archived ones too.
 *
 * Students, the lecture list and the new-lecture course picker all read this,
 * so the default has to exclude archived courses: an archived course must not
 * be offered as somewhere to put a new lecture. The admin Courses page is the
 * one caller that passes true, because it is where a course is restored.
 */
export async function listCourses(includeArchived = false): Promise<Course[]> {
  const where = includeArchived ? '' : 'WHERE c.archived_at IS NULL';
  const { rows } = await query<Course>(`SELECT ${FIELDS} FROM courses c
    LEFT JOIN lectures l ON l.course_id = c.id
    ${where}
    GROUP BY c.id ORDER BY c.created_at ASC, c.id ASC`);
  return rows;
}
export async function getCourse(id: number): Promise<Course> {
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Invalid course ID', 400);
  const { rows } = await query<Course>(`SELECT ${FIELDS} FROM courses c
    LEFT JOIN lectures l ON l.course_id = c.id
    WHERE c.id = $1 GROUP BY c.id`, [id]);
  if (!rows[0]) throw new AppError('Course not found', 404);
  return rows[0];
}
export async function defaultCourseId(): Promise<number> {
  const { rows } = await query<{ id: number }>(
    "SELECT id FROM courses WHERE legacy_key = 'original-playlist' LIMIT 1");
  if (!rows[0]) throw new AppError('Default course unavailable. Apply migration 022.', 503);
  return rows[0].id;
}
function validated(input: {title: string; subtitle?: string | null; description?: string | null}) {
  const title = (input.title ?? '').trim();
  const subtitle = (input.subtitle ?? '').trim();
  const description = (input.description ?? '').trim();
  if (!title || title.length > 160) throw new AppError('Course title must be 1-160 characters', 400);
  if (subtitle.length > 240) throw new AppError('Course subtitle must not exceed 240 characters', 400);
  if (description.length > 2000) throw new AppError('Course description must not exceed 2000 characters', 400);
  return {title, subtitle, description};
}
/** Two courses with the same name cannot be told apart in any list. */
async function assertTitleFree(title: string, exceptId?: number): Promise<void> {
  const { rows } = await query<{ id: number }>(
    'SELECT id FROM courses WHERE lower(btrim(title)) = lower($1) LIMIT 1', [title]);
  if (rows[0] && rows[0].id !== exceptId) {
    throw new AppError('A course with this title already exists.', 409);
  }
}
export async function createCourse(input: {title: string; subtitle?: string | null; description?: string | null}): Promise<Course> {
  const {title, subtitle, description} = validated(input);
  await assertTitleFree(title);
  const { rows } = await query<{id: number}>(
    'INSERT INTO courses (title, subtitle, description) VALUES ($1,$2,$3) RETURNING id',
    [title, subtitle, description]);
  return getCourse(rows[0].id);
}
export async function updateCourse(
  id: number, input: { title?: string | null; subtitle?: string | null; description?: string | null }
): Promise<Course> {
  const old = await getCourse(id);
  const {title, subtitle, description} = validated({
    title: input.title === undefined ? old.title : (input.title ?? ''),
    subtitle: input.subtitle === undefined ? old.subtitle : input.subtitle,
    description: input.description === undefined ? old.description : input.description,
  });
  await assertTitleFree(title, id);
  await query('UPDATE courses SET title=$1, subtitle=$2, description=$3, updated_at=NOW() WHERE id=$4',
    [title, subtitle, description, id]);
  return getCourse(id);
}

/** True for the course migration 022 seeded, which the product falls back to. */
async function isDefaultCourse(id: number): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(
    "SELECT (legacy_key = 'original-playlist') AS ok FROM courses WHERE id = $1", [id]);
  return rows[0]?.ok === true;
}

/**
 * Withdraw a course from use without destroying anything.
 *
 * Nothing is removed: the lectures, their datasets and every student question
 * recorded against them stay exactly as they are. The course simply stops being
 * listed, and restoreCourse puts it back.
 */
export async function archiveCourse(id: number): Promise<Course> {
  const course = await getCourse(id);
  if (course.archived_at) return course;
  // Every course can be archived, the seeded one included: the fallback
  // trigger from migration 022 looks the row up by legacy_key and does not
  // care whether it is archived, so hiding it breaks nothing.
  await query('UPDATE courses SET archived_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
  return getCourse(id);
}

export async function restoreCourse(id: number): Promise<Course> {
  await getCourse(id);
  await query('UPDATE courses SET archived_at = NULL, updated_at = NOW() WHERE id = $1', [id]);
  return getCourse(id);
}

/**
 * Permanent removal, allowed only where there is nothing to lose.
 *
 * A course that has ever held a lecture is refused: lectures carry datasets,
 * chunks and the questions asked against them, and removing the course row
 * would either break those references or take them with it. Such a course is
 * archived instead. This exists for a course created by mistake.
 */
export async function deleteCourse(id: number): Promise<void> {
  const course = await getCourse(id);
  // Deleting the seeded course would leave the fallback trigger pointing at a
  // row that is gone, so that one is archived rather than removed.
  if (await isDefaultCourse(id)) {
    throw new AppError('The first course cannot be deleted, because the database uses it as the fallback for lectures that name no course. Archive it instead.', 409);
  }
  if (course.lecture_count > 0) {
    throw new AppError(
      `This course has ${course.lecture_count} lecture${course.lecture_count === 1 ? '' : 's'}. Archive it instead, which keeps its lectures and the questions students asked.`,
      409);
  }
  await query('DELETE FROM courses WHERE id = $1', [id]);
}
