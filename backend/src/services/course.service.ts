import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';

export interface Course {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  lecture_count: number;
  ready_count: number;
}
const FIELDS = `c.id, c.title, c.subtitle, c.description, c.created_at, c.updated_at,
  COUNT(l.id)::int AS lecture_count,
  COUNT(l.id) FILTER (WHERE l.status = 'READY')::int AS ready_count`;

export async function listCourses(): Promise<Course[]> {
  const { rows } = await query<Course>(`SELECT ${FIELDS} FROM courses c
    LEFT JOIN lectures l ON l.course_id = c.id
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
export async function createCourse(input: {title: string; subtitle?: string | null; description?: string | null}): Promise<Course> {
  const {title, subtitle, description} = validated(input);
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
  await query('UPDATE courses SET title=$1, subtitle=$2, description=$3, updated_at=NOW() WHERE id=$4',
    [title, subtitle, description, id]);
  return getCourse(id);
}
