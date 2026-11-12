import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { getPlaylistMetadata, previewPlaylist, validPlaylistId } from './youtube-discovery.service';

export interface PersonalCourseVideo {
  video_id: string; title: string; thumbnail_url: string|null; position: number;
  ingest_status?: string; last_error?: string|null;
}
export interface PersonalCourse {
  id: string; playlist_id: string; title: string; channel_title: string;
  thumbnail_url: string|null; status: 'PREVIEW_ONLY' | 'QUEUED' | 'PROCESSING' | 'PARTIAL' | 'READY' | 'FAILED'; created_at: Date;
  last_error?: string|null;
  videos: PersonalCourseVideo[];
}
export const MAX_PERSONAL_COURSES = 10;

export const validatePersonalCourseId = (id: unknown): number => {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) throw new AppError('Invalid course ID', 400);
  return n;
};

export async function listPersonalCourses(studentId: string): Promise<PersonalCourse[]> {
  const { rows } = await query<PersonalCourse>(
    `SELECT c.id,c.playlist_id,c.title,c.channel_title,c.thumbnail_url,c.status,c.created_at,c.last_error,
      COALESCE(json_agg(json_build_object(
        'video_id',v.video_id,'title',v.title,'thumbnail_url',v.thumbnail_url,'position',v.position,
        'ingest_status',v.ingest_status,'last_error',v.last_error
      ) ORDER BY v.position) FILTER (WHERE v.video_id IS NOT NULL),'[]'::json) AS videos
      FROM student_youtube_courses c
      LEFT JOIN student_youtube_course_videos v ON v.course_id=c.id
      WHERE c.student_id=$1
      GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC`, [studentId]);
  return rows;
}

export async function addPersonalCourse(studentId: string, playlistId: string): Promise<PersonalCourse> {
  if (!validPlaylistId(playlistId)) throw new AppError('Invalid playlist ID', 400);
  // Both metadata calls are bounded and happen before holding any DB locks.
  const metadata = await getPlaylistMetadata(playlistId);
  const videos = (await previewPlaylist(playlistId)).slice(0, 2);
  if (!videos.length) throw new AppError('Playlist has no available preview videos', 422);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize this student's additions so concurrent requests cannot bypass
    // the 10-course cap. This is an existing user row, not a new lock table.
    const owner = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [studentId]);
    if (!owner.rows.length) throw new AppError('Student not found', 404);
    const existing = await client.query<{id:string}>(
      'SELECT id FROM student_youtube_courses WHERE student_id=$1 AND playlist_id=$2',
      [studentId,playlistId]);
    let courseId: string;
    if (existing.rows[0]) {
      courseId = existing.rows[0].id;
    } else {
      const count = await client.query<{n:number}>(
        'SELECT COUNT(*)::int AS n FROM student_youtube_courses WHERE student_id=$1',[studentId]);
      if (count.rows[0].n >= MAX_PERSONAL_COURSES) throw new AppError('Maximum 10 personal courses allowed', 409);
      const created = await client.query<{id:string}>(
        `INSERT INTO student_youtube_courses(student_id,playlist_id,title,channel_title,thumbnail_url)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [studentId,playlistId,metadata.title,metadata.channelTitle,metadata.thumbnail]);
      courseId = created.rows[0].id;
      for (let i=0;i<videos.length;i++) {
        const v=videos[i];
        await client.query(
          'INSERT INTO student_youtube_course_videos(course_id,video_id,title,thumbnail_url,position) VALUES($1,$2,$3,$4,$5)',
          [courseId,v.videoId,v.title,v.thumbnail,i+1]);
      }
    }
    await client.query('COMMIT');
    const courses = await listPersonalCourses(studentId);
    const found = courses.find(c => String(c.id) === String(courseId));
    if (!found) throw new AppError('Personal course unavailable', 503);
    return found;
  } catch(e) { await client.query('ROLLBACK').catch(()=>undefined); throw e; }
  finally { client.release(); }
}

export async function removePersonalCourse(studentId: string, id: number): Promise<void> {
  const { rowCount } = await query(
    'DELETE FROM student_youtube_courses WHERE id=$1 AND student_id=$2',
    [validatePersonalCourseId(id),studentId]);
  if (!rowCount) throw new AppError('Personal course not found', 404);
}
