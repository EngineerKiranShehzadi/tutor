import pool, {query} from '../config/database';
import {AppError} from '../middleware/errorHandler';

// These limits are intentionally conservative for Neon Free MVP deployments.
// Raising them is an explicit product/deployment decision, not a workaround.
export const PERSONAL_COURSE_LIMIT=2;
export const PERSONAL_VIDEO_LIMIT=2;
export const PERSONAL_CHUNK_BUDGET=240; // 2 courses x 2 videos x <=60 chunks
export const GLOBAL_ACTIVE_IMPORT_LIMIT=1;
export const DEFAULT_GLOBAL_DB_LIMIT_BYTES=700_000_000; // headroom below 1 GB
export const PERSONAL_IMPORT_TTL_DAYS=30;
export const GLOBAL_STORAGE_ALERT_PERCENT=80;

export function globalDatabaseLimit():number {
  const raw=process.env.YOUTUBE_DB_STORAGE_CEILING_BYTES;
  if(!raw)return DEFAULT_GLOBAL_DB_LIMIT_BYTES;
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<1_000_000)throw new Error('Invalid YOUTUBE_DB_STORAGE_CEILING_BYTES');
  return value;
}
export async function getStorageStats() {
  const {rows}=await query<{
    legacy_private_chunks:string;shared_chunks:string;unique_shared_versions:string;
    reused_mappings:string;database_bytes:string;legacy_chunk_table_bytes:string;shared_chunk_table_bytes:string;
  }>('SELECT * FROM youtube_storage_summary');
  const x=rows[0];
  return {
    databaseBytes:Number(x.database_bytes),
    maxDatabaseBytes:globalDatabaseLimit(),
    percentUsed:Math.round(Number(x.database_bytes)/globalDatabaseLimit()*100),
    legacyPrivateChunks:Number(x.legacy_private_chunks),
    sharedChunks:Number(x.shared_chunks),
    uniqueSharedVersions:Number(x.unique_shared_versions),
    reusedMappings:Number(x.reused_mappings),
    legacyChunkTableBytes:Number(x.legacy_chunk_table_bytes),
    sharedChunkTableBytes:Number(x.shared_chunk_table_bytes),
  };
}
export async function checkGlobalStorageLimit():Promise<void> {
  const {rows}=await query<{bytes:string}>('SELECT pg_database_size(current_database())::bigint AS bytes');
  if(Number(rows[0].bytes)>=globalDatabaseLimit())
    throw new AppError('YouTube imports paused: database storage safety limit reached',507);
}
export async function getStudentStorageUsage(studentId:string) {
  const {rows}=await query<{courses:string;videos:string;ready_videos:string;estimated_chunks:string}>(
    `SELECT
     COUNT(DISTINCT c.id)::int AS courses,
     COUNT(v.video_id)::int AS videos,
     COUNT(v.video_id) FILTER(WHERE v.ingest_status='READY')::int AS ready_videos,
     (COUNT(v.video_id) FILTER(WHERE v.ingest_status='READY') * 60)::int AS estimated_chunks
     FROM student_youtube_courses c LEFT JOIN student_youtube_course_videos v ON v.course_id=c.id
     WHERE c.student_id=$1`,[studentId]);
  const x=rows[0];
  return {courses:Number(x.courses),maxCourses:PERSONAL_COURSE_LIMIT,
    videos:Number(x.videos),readyVideos:Number(x.ready_videos),
    reservedChunkCapacity:Number(x.estimated_chunks),maxChunkCapacity:PERSONAL_CHUNK_BUDGET};
}

// Concurrency-safe admission: lock global import admission and this user row,
// then reserve the course in the same transaction.
export async function reserveYoutubeCourseImport(studentId:string,courseId:number) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(971, 331)');
    const user=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[studentId]);
    if(!user.rows.length)throw new AppError('Student not found',404);
    const course=await client.query<{id:string;status:string}>(
      'SELECT id,status FROM student_youtube_courses WHERE id=$1 AND student_id=$2 FOR UPDATE',
      [courseId,studentId]);
    if(!course.rows.length)throw new AppError('Personal course not found',404);
    if(!['PREVIEW_ONLY','FAILED','PARTIAL','EXPIRED'].includes(course.rows[0].status))
      throw new AppError('Course is already processing or ready',409);
    const active=await client.query<{n:number}>(
      "SELECT COUNT(*)::int AS n FROM student_youtube_courses WHERE status IN ('QUEUED','PROCESSING')");
    if(Number(active.rows[0].n)>=GLOBAL_ACTIVE_IMPORT_LIMIT)
      throw new AppError('An import is already running. Please retry after it finishes.',429);
    const used=await client.query<{n:number}>(
      `SELECT COUNT(*)::int AS n FROM student_youtube_course_videos v
       JOIN student_youtube_courses c ON c.id=v.course_id
       WHERE c.student_id=$1 AND v.ingest_status='READY'`,[studentId]);
    const selected=await client.query<{n:number}>(
      "SELECT COUNT(*)::int AS n FROM student_youtube_course_videos WHERE course_id=$1 AND ingest_status!='READY'",
      [courseId]);
    if((Number(used.rows[0].n)+Number(selected.rows[0].n))*60>PERSONAL_CHUNK_BUDGET)
      throw new AppError('Personal YouTube storage quota reached. Remove a course to free capacity.',429);
    const bytes=await client.query<{bytes:string}>('SELECT pg_database_size(current_database())::bigint AS bytes');
    if(Number(bytes.rows[0].bytes)>=globalDatabaseLimit())
      throw new AppError('YouTube imports paused: database storage safety limit reached',507);
    await client.query(
      "UPDATE student_youtube_courses SET status='QUEUED',last_error=NULL,updated_at=NOW() WHERE id=$1",
      [courseId]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}
  finally{client.release();}
}
