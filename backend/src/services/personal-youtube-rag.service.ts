import { createHash } from 'crypto';
import { reserveYoutubeCourseImport, checkGlobalStorageLimit, PERSONAL_IMPORT_TTL_DAYS } from './youtube-storage-policy.service';
import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getPlaylistMetadata } from './youtube-discovery.service';
import { pilotEnabled, fetchPilotCaptions } from './youtube-import.service';
import { captionCuesToRows } from './subtitle-ingestion.service';
import type { CaptionCue } from './subtitle-ingestion.service';
import { buildChunkPiecesReport } from './chunk.service';
import { generateEmbedding, generateEmbeddingsBatch, EMBEDDING_MODEL_VERSION } from './embedding.service';
import { rerankChunks, dedupeAndSelect } from './rerank.service';
import { generateAnswer } from './answer-generation.service';
import { runInputGuardrails, REJECTION_MESSAGE_BY_REASON } from '../rag/guardrails/input/input-guardrail.service';
import { runOutputGuardrail } from '../rag/guardrails/output/output-guardrail.service';
import { enforceAskQuota } from './ask-quota.service';
import type { QnaChunk } from '../types';
import { validatePersonalCourseId } from './student-youtube-course.service';

export const MAX_PERSONAL_VIDEO_CHUNKS = 60;
export const PERSONAL_DAILY_ASK_LIMIT = 20;
export const personalRagEnabled = (): boolean =>
  pilotEnabled() && process.env.YOUTUBE_STUDENT_RAG_PILOT_ENABLED === 'true';

export interface PrivateCitation {
  videoId: string;
  videoTitle: string;
  startTime: string;
  endTime: string;
  url: string;
}
type PrivateChunk = QnaChunk & { video_id: string; video_title: string };

export function vectorLiteral(values: number[]): string {
  if (values.length !== 1024 || values.some(v => !Number.isFinite(v)))
    throw new AppError('Embedding dimension mismatch', 503);
  return '[' + values.join(',') + ']';
}
export function citationUrl(videoId: string, startTime: string): string {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(startTime))
    throw new AppError('Invalid video citation', 500);
  const [h,m,s] = startTime.split(/[.:]/).map(Number);
  return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + (h*3600+m*60+s) + 's';
}
const safeFailure = (error: unknown): string =>
  error instanceof AppError ? error.message.slice(0,180) : 'Import failed';

async function requireOwnedCourse(studentId: string, courseId: number) {
  const { rows } = await query<{id:string;title:string;status:string}>(
    'SELECT id,title,status FROM student_youtube_courses WHERE id=$1 AND student_id=$2',
    [validatePersonalCourseId(courseId),studentId]
  );
  if (!rows[0]) throw new AppError('Personal course not found',404);
  return rows[0];
}

export async function queuePersonalRag(studentId: string, courseId: number): Promise<void> {
  if (!personalRagEnabled()) throw new AppError('Personal AI tutor pilot is disabled',503);
  await requireOwnedCourse(studentId,courseId);
  await reserveYoutubeCourseImport(studentId,courseId);
}

interface Video { video_id:string;title:string;ingest_status:string }
interface IndexedChunk {
  question:string; answer:string; chunkText:string; start:string; end:string; vector:string;
}
// Injectable caption and embedding adapters allow a real PostgreSQL integration
// test without network calls or model credentials. Production uses the existing
// adapters unchanged; this function is never exposed as a public API.
export interface PersonalIndexDeps {
  fetchCaptions?: (videoId: string) => Promise<{ language: string; cues: CaptionCue[] }>;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  /** Test adapter only: exercise the shared persistence/reuse branch with deterministic providers. */
  allowSharedReuse?: boolean;
}
export async function indexPersonalVideo(courseId: number, video: Video, deps: PersonalIndexDeps = {}): Promise<void> {
  // Always compare a fresh, normalized transcript fingerprint before reuse.
  // This prevents a changed public transcript from silently reusing old vectors.
  const captions = await (deps.fetchCaptions ?? fetchPilotCaptions)(video.video_id);
  const sourceRows = captionCuesToRows(video.video_id + '.vtt',captions.cues).rows;
  const prepared: Array<Omit<IndexedChunk,'vector'>> = [];
  for (const row of sourceRows) {
    const { pieces } = await buildChunkPiecesReport(row);
    for (const piece of pieces) {
      prepared.push({
        question: row.question || 'Source excerpt',
        answer: row.answer || '',
        chunkText: piece.chunkText,
        start: row.start_time || '00:00:00.000',
        end: row.end_time || '00:00:00.000',
      });
      if (prepared.length > MAX_PERSONAL_VIDEO_CHUNKS)
        throw new AppError('Pilot video is too long (max 60 chunks)',413);
    }
  }
  if (!prepared.length) throw new AppError('No usable transcript segments',422);
  const transcriptHash=createHash('sha256')
    .update(JSON.stringify({cues:captions.cues,pieces:prepared.map(p=>[p.start,p.end,p.chunkText]),model:EMBEDDING_MODEL_VERSION}))
    .digest('hex');
  // Reuse a matching public transcript before calling the paid embedding API.
  // Student ownership remains on the course/video mapping. A key-share lock
  // prevents the optional retention sweeper from deleting this version
  // between finding it and creating the new reference.
  if ((!deps.fetchCaptions && !deps.embedBatch) || deps.allowSharedReuse === true) {
    const sharedClient=await pool.connect();
    try {
      await sharedClient.query('BEGIN');
      const {rows: matches}=await sharedClient.query<{id:string}>(
        `SELECT id FROM youtube_shared_content
         WHERE video_id=$1 AND embedding_model_version=$2 AND transcript_sha256=$3
         FOR KEY SHARE`,
        [video.video_id,EMBEDDING_MODEL_VERSION,transcriptHash]);
      if(matches[0]){
        const mapped=await sharedClient.query(
          `UPDATE student_youtube_course_videos v
           SET shared_content_id=$3,ingest_status='READY',last_error=NULL
           WHERE v.course_id=$1 AND v.video_id=$2
             AND EXISTS(SELECT 1 FROM youtube_shared_chunks ch WHERE ch.content_id=$3)`,
          [courseId,video.video_id,matches[0].id]);
        if(mapped.rowCount){
          await sharedClient.query(
            'DELETE FROM student_youtube_course_chunks WHERE course_id=$1 AND video_id=$2',
            [courseId,video.video_id]);
          await sharedClient.query('COMMIT');
          return;
        }
      }
      await sharedClient.query('ROLLBACK');
    }catch(err){await sharedClient.query('ROLLBACK').catch(()=>undefined);throw err;}
    finally{sharedClient.release();}
  }
  await checkGlobalStorageLimit();
  const vectors: string[] = [];
  for (let i=0;i<prepared.length;i+=8) {
    const batch = await (deps.embedBatch ?? generateEmbeddingsBatch)(prepared.slice(i,i+8).map(c=>c.chunkText));
    if (batch.length !== Math.min(8,prepared.length-i)) throw new AppError('Incomplete embedding batch',503);
    for (const v of batch) vectors.push(vectorLiteral(v));
    await query('UPDATE student_youtube_courses SET updated_at=NOW() WHERE id=$1',[courseId]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned=await client.query('SELECT id FROM student_youtube_courses WHERE id=$1 FOR UPDATE',[courseId]);
    if(!owned.rows.length)throw new AppError('Course deleted during ingestion',409);
    // Offline deterministic DB tests deliberately preserve the legacy private
    // storage path to verify backward-compatible reads.
    if ((deps.fetchCaptions || deps.embedBatch) && deps.allowSharedReuse !== true) {
      await client.query('DELETE FROM student_youtube_course_chunks WHERE course_id=$1 AND video_id=$2',[courseId,video.video_id]);
      for(let i=0;i<prepared.length;i++){
        const piece=prepared[i];
        await client.query(
          `INSERT INTO student_youtube_course_chunks
           (course_id,video_id,chunk_index,question,answer,chunk_text,start_time,end_time,embedding_model_version,local_embedding)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)`,
          [courseId,video.video_id,i,piece.question,piece.answer,piece.chunkText,piece.start,piece.end,EMBEDDING_MODEL_VERSION,vectors[i]]);
      }
      await client.query(
        "UPDATE student_youtube_course_videos SET ingest_status='READY',shared_content_id=NULL,last_error=NULL WHERE course_id=$1 AND video_id=$2",
        [courseId,video.video_id]);
      await client.query('COMMIT');
      return;
    }
    const shared=await client.query<{id:string}>(
      `INSERT INTO youtube_shared_content(video_id,embedding_model_version,transcript_sha256,language)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(video_id,embedding_model_version,transcript_sha256)
       DO UPDATE SET language=EXCLUDED.language
       RETURNING id`,
      [video.video_id,EMBEDDING_MODEL_VERSION,transcriptHash,captions.language]);
    const sharedId=shared.rows[0].id;
    for(let i=0;i<prepared.length;i++){
      const c=prepared[i];
      await client.query(
        `INSERT INTO youtube_shared_chunks
         (content_id,chunk_index,question,answer,chunk_text,start_time,end_time,local_embedding)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector)
         ON CONFLICT(content_id,chunk_index) DO NOTHING`,
        [sharedId,i,c.question,c.answer,c.chunkText,c.start,c.end,vectors[i]]);
    }
    // Existing per-course chunks remain intact until this mapping is committed.
    await client.query('DELETE FROM student_youtube_course_chunks WHERE course_id=$1 AND video_id=$2',
      [courseId,video.video_id]);
    await client.query(
      `UPDATE student_youtube_course_videos
       SET ingest_status='READY',shared_content_id=$3,last_error=NULL
       WHERE course_id=$1 AND video_id=$2`,
      [courseId,video.video_id,sharedId]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}
  finally{client.release();}

}

let busy = false;
export async function runPersonalRagJob(courseId: number): Promise<void> {
  if (busy || !personalRagEnabled()) return;
  busy = true;
  try {
    const { rows: claimed } = await query<{id:string}>(
      "UPDATE student_youtube_courses SET status='PROCESSING',updated_at=NOW() " +
      "WHERE id=$1 AND status='QUEUED' RETURNING id",[courseId]);
    if (!claimed[0]) return;
    const { rows: videos } = await query<Video>(
      'SELECT video_id,title,ingest_status FROM student_youtube_course_videos WHERE course_id=$1 ORDER BY position LIMIT 2',
      [courseId]);
    let success=0, failure:string|null=null;
    for (const video of videos) {
      if (video.ingest_status==='READY') { success++; continue; }
      try {
        await query(
          "UPDATE student_youtube_course_videos SET ingest_status='PROCESSING',last_error=NULL WHERE course_id=$1 AND video_id=$2",
          [courseId,video.video_id]);
        await indexPersonalVideo(courseId,video);
        success++;
      } catch(e) {
        failure=safeFailure(e);
        await query(
          "UPDATE student_youtube_course_videos SET ingest_status='FAILED',last_error=$3 WHERE course_id=$1 AND video_id=$2",
          [courseId,video.video_id,failure]);
        logger.warn('[PERSONAL-RAG] Video indexing failed for '+video.video_id);
      }
      await query('UPDATE student_youtube_courses SET updated_at=NOW() WHERE id=$1',[courseId]);
    }
    await query(
      `UPDATE student_youtube_courses
       SET status=$2,last_error=$3,updated_at=NOW(),
           expires_at=CASE WHEN $2 IN ('READY','PARTIAL')
                     THEN NOW()+($4::int * INTERVAL '1 day') ELSE expires_at END,
           last_accessed_at=CASE WHEN $2 IN ('READY','PARTIAL') THEN NOW() ELSE last_accessed_at END
       WHERE id=$1`,
      [courseId,success===videos.length&&success>0?'READY':success?'PARTIAL':'FAILED',failure,PERSONAL_IMPORT_TTL_DAYS]);
  } catch(e) {
    logger.error('[PERSONAL-RAG] Worker failed',{type:(e as Error)?.name});
    await query(
      "UPDATE student_youtube_courses SET status='FAILED',last_error='Import worker failed',updated_at=NOW() WHERE id=$1",
      [courseId]).catch(()=>undefined);
  } finally { busy=false; }
}

export async function resumePersonalRagJobs(): Promise<void> {
  if (!personalRagEnabled() || busy) return;
  // Single-process local pilot. Stale work is retried after 20 minutes.
  await query(
    "UPDATE student_youtube_courses SET status='QUEUED' WHERE status='PROCESSING' " +
    "AND updated_at < NOW()-INTERVAL '20 minutes'"
  );
  const { rows } = await query<{id:string}>(
    "SELECT id FROM student_youtube_courses WHERE status='QUEUED' ORDER BY updated_at LIMIT 1"
  );
  if (rows[0]) void runPersonalRagJob(Number(rows[0].id));
}

async function reservePersonalAsk(studentId:string,courseId:number):Promise<string> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[studentId]);
    const { rows } = await client.query<{n:number}>(
      "SELECT COUNT(*)::int AS n FROM student_youtube_course_asks " +
      "WHERE student_id=$1 AND asked_at>NOW()-INTERVAL '24 hours'",[studentId]);
    if (rows[0].n>=PERSONAL_DAILY_ASK_LIMIT)
      throw new AppError('Personal AI tutor daily question limit reached',429);
    const inserted=await client.query<{id:string}>(
      'INSERT INTO student_youtube_course_asks(course_id,student_id) VALUES($1,$2) RETURNING id',
      [courseId,studentId]);
    await client.query('COMMIT');
    return inserted.rows[0].id;
  } catch(e) { await client.query('ROLLBACK').catch(()=>undefined); throw e; }
  finally { client.release(); }
}

// Test-only dependency seam; REST calls pass no overrides and use the real
// providers, guardrails and per-student quota. Keep the SQL owner check live.
export interface PersonalAskDeps {
  embedQuery?: typeof generateEmbedding;
  rerank?: typeof rerankChunks;
  generate?: typeof generateAnswer;
  inputGuard?: typeof runInputGuardrails;
  outputGuard?: typeof runOutputGuardrail;
  quota?: typeof enforceAskQuota;
}
export async function askPersonalRag(studentId:string,courseId:number,rawQuestion:string,deps:PersonalAskDeps={},videoId?:string):Promise<{
  answer:string;sources:PrivateCitation[];
}> {
  if (!personalRagEnabled()) throw new AppError('Personal AI tutor pilot is disabled',503);
  const course=await requireOwnedCourse(studentId,courseId);
  if (course.status!=='READY' && course.status!=='PARTIAL')
    throw new AppError('AI tutor is not ready. Import the captions first.',409);
  if (typeof rawQuestion!=='string' || rawQuestion.trim().length<3 || rawQuestion.length>500)
    throw new AppError('Question must be 3-500 characters',400);
  if (videoId !== undefined) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new AppError('Invalid video ID',400);
    const video = await query(
      "SELECT 1 FROM student_youtube_course_videos WHERE course_id=$1 AND video_id=$2 AND ingest_status='READY'",
      [courseId,videoId]
    );
    if (!video.rows.length) throw new AppError('Lecture is not ready for tutoring',409);
  }
  const guard=await (deps.inputGuard ?? runInputGuardrails)(rawQuestion);
  if (guard.action==='REJECT')
    throw new AppError(REJECTION_MESSAGE_BY_REASON[guard.reason!] || 'Question rejected',400);
  const question=(guard.sanitizedInput || rawQuestion).trim();
  await (deps.quota ?? enforceAskQuota)(studentId);
  const reservation=await reservePersonalAsk(studentId,courseId);
  try {
    const embedding=vectorLiteral(await (deps.embedQuery ?? generateEmbedding)(question,true));
    // Both owner and course ID are enforced at the actual evidence SELECT.
    // Prefer per-student legacy chunks for untouched pre-migration courses,
    // otherwise read immutable shared chunks through owner-checked video maps.
    const {rows}=await query<PrivateChunk>(
      `SELECT ev.id,ev.chunk_index,ev.question,ev.answer,ev.chunk_text,
              ev.start_time,ev.end_time,ev.video_id,ev.video_title,
              ev.topic,ev.keywords
       FROM (
         SELECT k.id,k.chunk_index,k.question,k.answer,k.chunk_text,
                k.start_time,k.end_time,k.video_id,v.title AS video_title,
                v.title AS topic,NULL::text AS keywords,k.local_embedding
         FROM student_youtube_course_chunks k
         JOIN student_youtube_course_videos v ON v.course_id=k.course_id AND v.video_id=k.video_id
         JOIN student_youtube_courses c ON c.id=k.course_id
         WHERE c.student_id=$2 AND c.id=$3 AND k.embedding_model_version=$4
           AND ($5::text IS NULL OR k.video_id=$5)
           AND v.ingest_status='READY'
           AND v.shared_content_id IS NULL
         UNION ALL
         SELECT ch.content_id::integer,ch.chunk_index,ch.question,ch.answer,ch.chunk_text,
                ch.start_time,ch.end_time,v.video_id,v.title,v.title,NULL::text,ch.local_embedding
         FROM student_youtube_course_videos v
         JOIN student_youtube_courses c ON c.id=v.course_id
         JOIN youtube_shared_content sc ON sc.id=v.shared_content_id AND sc.embedding_model_version=$4
         JOIN youtube_shared_chunks ch ON ch.content_id=sc.id
         WHERE c.id=$3 AND c.student_id=$2 AND v.ingest_status='READY'
           AND ($5::text IS NULL OR v.video_id=$5)
       ) ev ORDER BY ev.local_embedding <=> $1::vector LIMIT 12`,
      [embedding,studentId,courseId,EMBEDDING_MODEL_VERSION,videoId??null]
    );
    // TTL is based on a real tutoring access, never on a background status poll.
    await query(
      "UPDATE student_youtube_courses SET last_accessed_at=NOW(),expires_at=NOW()+($2::int * INTERVAL '1 day') WHERE id=$1 AND student_id=$3",
      [courseId,PERSONAL_IMPORT_TTL_DAYS,studentId]);
    if (!rows.length) return {answer:'I could not find this information in this course.',sources:[]};
    const ranked=await (deps.rerank ?? rerankChunks)(question,rows,5);
    const selected=dedupeAndSelect(ranked,5).selected as PrivateChunk[];
    if (!selected.length) return {answer:'I could not find this information in this course.',sources:[]};
    const draft=await (deps.generate ?? generateAnswer)(question,selected,course.title);
    const outcome=await (deps.outputGuard ?? runOutputGuardrail)({
      question,effectiveQuery:question,uncoveredAspects:[],
      evidenceTexts:selected.map(s=>s.chunk_text),
      draftAnswer:draft,notFoundMessage:'I could not find this information in this course.',
    });
    if (outcome.verificationUnavailable) throw new AppError('Could not verify the answer. Please retry.',503);
    const sources:PrivateCitation[]=outcome.verified ? selected.map(s=>({
      videoId:s.video_id,videoTitle:s.video_title,startTime:s.start_time || '00:00:00.000',
      endTime:s.end_time || '00:00:00.000',url:citationUrl(s.video_id,s.start_time || '00:00:00.000'),
    })) : [];
    return {answer:outcome.finalAnswer,sources};
  } catch(e) {
    await query('DELETE FROM student_youtube_course_asks WHERE id=$1 AND student_id=$2',
      [reservation,studentId]).catch(()=>undefined);
    throw e;
  }
}
