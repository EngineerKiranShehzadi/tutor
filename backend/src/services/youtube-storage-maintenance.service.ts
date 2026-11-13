import pool, {query} from '../config/database';
import {logger} from '../utils/logger';
import {PERSONAL_IMPORT_TTL_DAYS} from './youtube-storage-policy.service';

// Per-process maintenance; deliberately bounded and no HTTP exposure.
// Expiring a course removes only reusable indexed evidence, never personal
// course metadata or historical chat messages. A re-import is explicit.
export async function sweepYoutubeStorage():Promise<{expired:number;orphaned:number}> {
  const client=await pool.connect();
  let expired=0,orphaned=0;
  try {
    await client.query('BEGIN');
    // Prevent concurrent sweepers. Return immediately if another instance is active.
    const lock=await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(971,332) AS locked');
    if(!lock.rows[0].locked){await client.query('ROLLBACK');return {expired:0,orphaned:0};}
    const candidates=await client.query<{id:string}>(
      `SELECT id FROM student_youtube_courses
       WHERE status IN ('READY','PARTIAL')
         AND COALESCE(expires_at,last_accessed_at + ($1::int * INTERVAL '1 day')) < NOW()
       ORDER BY last_accessed_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED`,
       [PERSONAL_IMPORT_TTL_DAYS]);
    for(const row of candidates.rows){
      // Preserve all chats; mark videos unindexed and drop old private chunk
      // copies. Shared embeddings persist if any other course references them.
      await client.query('DELETE FROM student_youtube_course_chunks WHERE course_id=$1',[row.id]);
      await client.query(
        "UPDATE student_youtube_course_videos SET shared_content_id=NULL,ingest_status='EXPIRED' WHERE course_id=$1 AND ingest_status='READY'",
        [row.id]);
      await client.query(
        "UPDATE student_youtube_courses SET status='EXPIRED',expires_at=NULL,updated_at=NOW() WHERE id=$1",
        [row.id]);
      expired++;
    }
    // Grace period avoids racing active imports and gives transient failures
    // time to recover. FK references protect content still used by students.
    const clean=await client.query(
      `DELETE FROM youtube_shared_content sc
       WHERE sc.created_at < NOW()-INTERVAL '21 days'
         AND NOT EXISTS (
           SELECT 1 FROM student_youtube_course_videos v WHERE v.shared_content_id=sc.id
         )
       RETURNING id`);
    orphaned=clean.rowCount||0;
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}
  finally{client.release();}
  if(expired||orphaned)logger.info('[YOUTUBE-STORAGE] retention sweep completed',{expired,orphaned});
  return {expired,orphaned};
}
