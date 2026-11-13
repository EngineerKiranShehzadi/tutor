import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { askPersonalRag } from './personal-youtube-rag.service';

const validId = (id: unknown) => {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) throw new AppError('Invalid ID',400);
  return n;
};
const validVideo = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);

async function requireSession(owner: string, courseId: number, sessionId: number) {
  const { rows } = await query<{id:string;video_id:string}>(
    'SELECT s.id,s.video_id FROM student_youtube_chat_sessions s JOIN student_youtube_courses c ON c.id=s.course_id AND c.student_id=s.student_id WHERE s.id=$1 AND s.student_id=$2 AND s.course_id=$3',
    [validId(sessionId),owner,validId(courseId)]
  );
  if (!rows[0]) throw new AppError('Chat not found',404);
  return rows[0];
}
export async function listYoutubeSessions(owner: string, courseId: number, videoId: string) {
  if (!validVideo(videoId)) throw new AppError('Invalid video ID',400);
  const { rows: course } = await query('SELECT id FROM student_youtube_courses WHERE id=$1 AND student_id=$2',[validId(courseId),owner]);
  if (!course.length) throw new AppError('Course not found',404);
  const {rows} = await query(
    'SELECT id,title,video_id,created_at,updated_at FROM student_youtube_chat_sessions WHERE student_id=$1 AND course_id=$2 AND video_id=$3 ORDER BY updated_at DESC LIMIT 100',
    [owner,courseId,videoId]
  );
  return rows;
}
export async function createYoutubeSession(owner: string, courseId: number, videoId: string) {
  if (!validVideo(videoId)) throw new AppError('Invalid video ID',400);
  const {rows} = await query<{id:string}>(
    `INSERT INTO student_youtube_chat_sessions(student_id,course_id,video_id)
     SELECT $1,c.id,v.video_id FROM student_youtube_courses c
     JOIN student_youtube_course_videos v ON v.course_id=c.id
     WHERE c.id=$2 AND c.student_id=$1 AND v.video_id=$3 AND v.ingest_status='READY'
     RETURNING id`,[owner,validId(courseId),videoId]
  );
  if (!rows[0]) throw new AppError('Lecture not ready or not owned',404);
  return rows[0];
}
export async function readYoutubeSession(owner: string, courseId: number, sessionId: number) {
  const session=await requireSession(owner,courseId,sessionId);
  const {rows}=await query(
    'SELECT id,role,content,sources,created_at FROM student_youtube_chat_messages WHERE session_id=$1 ORDER BY id LIMIT 200',
    [session.id]
  );
  return {session,messages:rows};
}
export async function renameYoutubeSession(owner:string,courseId:number,sessionId:number,title:string) {
  if (!title.trim() || title.length>120) throw new AppError('Invalid title',400);
  await requireSession(owner,courseId,sessionId);
  await query('UPDATE student_youtube_chat_sessions SET title=$1,updated_at=NOW() WHERE id=$2 AND student_id=$3',
    [title.trim(),sessionId,owner]);
}
export async function removeYoutubeSession(owner:string,courseId:number,sessionId:number) {
  await requireSession(owner,courseId,sessionId);
  await query('DELETE FROM student_youtube_chat_sessions WHERE id=$1 AND student_id=$2',[sessionId,owner]);
}
export async function askYoutubeSession(owner:string,courseId:number,sessionId:number,question:string) {
  const session=await requireSession(owner,courseId,sessionId);
  // Generate first: an unavailable provider must not write a partial exchange.
  const result=await askPersonalRag(owner,courseId,question,{},session.video_id);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const check=await client.query('SELECT id FROM student_youtube_chat_sessions WHERE id=$1 AND student_id=$2 AND course_id=$3 FOR UPDATE',[sessionId,owner,courseId]);
    if (!check.rows.length) throw new AppError('Chat was deleted',404);
    await client.query('INSERT INTO student_youtube_chat_messages(session_id,role,content) VALUES($1,$2,$3)',
      [sessionId,'user',question.trim()]);
    await client.query('INSERT INTO student_youtube_chat_messages(session_id,role,content,sources) VALUES($1,$2,$3,$4::jsonb)',
      [sessionId,'ai',result.answer,JSON.stringify(result.sources)]);
    await client.query("UPDATE student_youtube_chat_sessions SET updated_at=NOW(),title=CASE WHEN title='New Chat' THEN $2 ELSE title END WHERE id=$1",
      [sessionId,question.trim().slice(0,120)]);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
  return result;
}
