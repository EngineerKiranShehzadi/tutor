import { spawn } from 'child_process';
import path from 'path';
import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getCourse } from './course.service';
import { prepareDatasetVersion, finishDatasetVersion } from './dataset-version.service';
import { captionCuesToRows, CaptionCue } from './subtitle-ingestion.service';
import { previewPlaylist, validPlaylistId } from './youtube-discovery.service';

export const PILOT_VIDEO_LIMIT = 2;
const PYTHON = process.env.YOUTUBE_TRANSCRIPT_PYTHON || 'python3';
const SCRIPT = path.resolve(__dirname, '../../scripts/fetch_youtube_transcript.py');
const MAX_BYTES = 2_000_000;
export const pilotEnabled = () => process.env.YOUTUBE_PILOT_ENABLED === 'true' &&
  process.env.YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED === 'true' &&
  process.env.NODE_ENV !== 'production';

export function validateCaptionPayload(value: any): { language: string; cues: CaptionCue[] } {
  if (!value || !Array.isArray(value.cues) || !value.cues.length || value.cues.length > 20000)
    throw new AppError('No usable captions', 422);
  const cues = value.cues as CaptionCue[];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (!Number.isSafeInteger(c.startMs) || !Number.isSafeInteger(c.endMs) ||
      c.startMs < 0 || c.endMs <= c.startMs || typeof c.text !== 'string' ||
      c.text.length > 10000 || (i > 0 && c.startMs < cues[i-1].startMs))
      throw new AppError('Invalid caption timing', 422);
  }
  return { language: String(value.language || 'unknown').slice(0, 16), cues };
}

export function fetchPilotCaptions(videoId: string): Promise<{language: string; cues: CaptionCue[]}> {
  if (!pilotEnabled()) throw new AppError('Experimental transcript import disabled', 503);
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new AppError('Invalid video ID', 400);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, videoId], { shell: false, stdio: ['ignore','pipe','ignore'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let text = '', size = 0, done = false;
    const finish = (err?: Error, data?: {language:string;cues:CaptionCue[]}) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (err) reject(err); else resolve(data!);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AppError('Caption fetch timed out', 504)); }, 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) { child.kill('SIGKILL'); finish(new AppError('Caption output too large', 413)); }
      else text += chunk.toString('utf8');
    });
    child.on('error', () => finish(new AppError('Caption extractor unavailable', 503)));
    child.on('close', code => {
      if (done) return;
      if (code !== 0) { finish(new AppError('Captions unavailable', 422)); return; }
      try { finish(undefined, validateCaptionPayload(JSON.parse(text))); }
      catch { finish(new AppError('Invalid caption extractor output', 422)); }
    });
  });
}

interface Job {
  id: string; course_id: number; playlist_id: string; requested_by: string;
  status: string; total_videos: number; completed_videos: number; last_error: string|null;
}
const safeError = (e: unknown): string => e instanceof AppError ? e.message.slice(0, 180) : 'Import failed';
export async function getImportJob(id: number, userId: string): Promise<{job: Job; videos: any[]}> {
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Invalid job ID', 400);
  const { rows } = await query<Job>('SELECT * FROM youtube_import_jobs WHERE id=$1 AND requested_by=$2', [id,userId]);
  if (!rows[0]) throw new AppError('Import job not found', 404);
  const videos = await query('SELECT video_id,title,lecture_id,status,last_error FROM youtube_import_videos WHERE job_id=$1 ORDER BY video_id', [id]);
  return { job: rows[0], videos: videos.rows };
}
export async function enqueueImport(courseId: number, playlistId: string, userId: string): Promise<Job> {
  if (!pilotEnabled()) throw new AppError('Experimental transcript import disabled', 503);
  if (!validPlaylistId(playlistId) || !Number.isSafeInteger(courseId) || courseId < 1)
    throw new AppError('Invalid course or playlist ID', 400);
  const course = await getCourse(courseId);
  if (course.archived_at) throw new AppError('Course is archived', 409);
  const { rows: pending } = await query<{n: number}>("SELECT COUNT(*)::int AS n FROM youtube_import_jobs WHERE status IN ('PENDING','RUNNING')");
  if (pending[0].n >= 2) throw new AppError('Pilot import capacity reached', 429);
  const { rows } = await query<Job>(
    'INSERT INTO youtube_import_jobs(course_id,playlist_id,requested_by) VALUES($1,$2,$3) ' +
    'ON CONFLICT(course_id,playlist_id) DO UPDATE SET updated_at=youtube_import_jobs.updated_at RETURNING *',
    [courseId,playlistId,userId]);
  if (rows[0].requested_by !== userId) throw new AppError('Playlist already imported into this course', 409);
  return rows[0];
}

// One transaction creates the lecture, agent profile and import checkpoint.
async function ensureImportedLecture(jobId: number, courseId: number, video: {videoId:string;title:string}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{lecture_id:number|null}>(
      'SELECT lecture_id FROM youtube_import_videos WHERE job_id=$1 AND video_id=$2 FOR UPDATE',
      [jobId,video.videoId]);
    if (existing.rows[0]?.lecture_id) { await client.query('COMMIT'); return existing.rows[0].lecture_id; }
    const sql = [
      'WITH new_lecture AS (',
      'INSERT INTO lectures(title,description,youtube_url,youtube_video_id,course_id)',
      'VALUES($1,$2,$3,$4,$5) RETURNING id',
      '), profile AS (',
      'INSERT INTO lecture_agent_profiles(lecture_id,agent_name,instructions)',
      "SELECT id,'Course Tutor','Answer only from this lecture dataset and cite timestamps.' FROM new_lecture",
      ') SELECT id FROM new_lecture',
    ].join(' ');
    const { rows } = await client.query<{id:number}>(sql,
      [video.title.slice(0,160),'Experimental YouTube caption import',
        'https://www.youtube.com/watch?v='+video.videoId,video.videoId,courseId]);
    await client.query(
      "INSERT INTO youtube_import_videos(job_id,video_id,lecture_id,title,status) VALUES($1,$2,$3,$4,'PROCESSING') " +
      "ON CONFLICT(job_id,video_id) DO UPDATE SET lecture_id=EXCLUDED.lecture_id,title=EXCLUDED.title,status='PROCESSING',last_error=NULL,updated_at=NOW()",
      [jobId,video.videoId,rows[0].id,video.title.slice(0,200)]);
    await client.query('COMMIT');
    return rows[0].id;
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

let working = false;
export async function runImport(id: number): Promise<void> {
  if (working || !pilotEnabled()) return;
  working = true;
  try {
    const {rows} = await query<Job>(
      "UPDATE youtube_import_jobs SET status='RUNNING',updated_at=NOW(),last_error=NULL WHERE id=$1 AND status='PENDING' RETURNING *", [id]);
    if (!rows[0]) return;
    const job = rows[0];
    let videos: Array<{videoId:string;title:string}>;
    try {
      videos = await previewPlaylist(job.playlist_id);
      if (!videos.length) throw new AppError('No playlist videos available', 422);
      await query('UPDATE youtube_import_jobs SET total_videos=$2,updated_at=NOW() WHERE id=$1',[id,videos.length]);
    } catch(e) {
      await query("UPDATE youtube_import_jobs SET status='FAILED',last_error=$2,updated_at=NOW() WHERE id=$1",[id,safeError(e)]);
      return;
    }
    let success = 0, lastError: string|null = null;
    for (const video of videos) {
      const prior = await query<{status:string}>(
        'SELECT status FROM youtube_import_videos WHERE job_id=$1 AND video_id=$2',[id,video.videoId]);
      if (prior.rows[0]?.status === 'READY') { success++; continue; }
      try {
        const captions = await fetchPilotCaptions(video.videoId);
        const rows = captionCuesToRows(video.videoId + '-' + captions.language + '.vtt', captions.cues).rows;
        const lectureId = await ensureImportedLecture(id,job.course_id,video);
        const prepared = await prepareDatasetVersion(lectureId,Buffer.from(JSON.stringify(captions.cues)),{
          mode:'MERGE',filename:video.videoId+'.captions.json',rawRows:rows,
        });
        if (prepared.kind === 'CREATED') {
          const finished = await finishDatasetVersion(prepared.versionId);
          if (finished.outcome !== 'ACTIVATED' && finished.outcome !== 'SKIPPED')
            throw new AppError('Embedding not ready',503);
        }
        await query("UPDATE youtube_import_videos SET status='READY',last_error=NULL,updated_at=NOW() WHERE job_id=$1 AND video_id=$2",
          [id,video.videoId]);
        success++;
      } catch(e) {
        lastError = safeError(e);
        await query(
          "INSERT INTO youtube_import_videos(job_id,video_id,title,status,last_error) VALUES($1,$2,$3,'FAILED',$4) " +
          "ON CONFLICT(job_id,video_id) DO UPDATE SET status='FAILED',last_error=EXCLUDED.last_error,updated_at=NOW()",
          [id,video.videoId,video.title.slice(0,200),lastError]);
        logger.warn('[YOUTUBE] Pilot video failed: '+video.videoId);
      }
      await query('UPDATE youtube_import_jobs SET completed_videos=$2,updated_at=NOW() WHERE id=$1',[id,success]);
    }
    await query('UPDATE youtube_import_jobs SET status=$2,completed_videos=$3,last_error=$4,updated_at=NOW() WHERE id=$1',
      [id,success===videos.length?'READY':success?'PARTIAL':'FAILED',success,lastError]);
  } catch(e) {
    logger.error('[YOUTUBE] Import worker failed',{type:(e as Error)?.name});
    await query("UPDATE youtube_import_jobs SET status='FAILED',last_error='Worker failed',updated_at=NOW() WHERE id=$1",[id]).catch(()=>undefined);
  } finally { working = false; }
}
export async function retryImport(id:number,userId:string):Promise<Job> {
  if (!pilotEnabled()) throw new AppError('Experimental transcript import disabled',503);
  const {rows}=await query<Job>(
    "UPDATE youtube_import_jobs SET status='PENDING',last_error=NULL,updated_at=NOW() " +
    "WHERE id=$1 AND requested_by=$2 AND status IN ('FAILED','PARTIAL') RETURNING *",[id,userId]);
  if (!rows[0]) throw new AppError('No retryable import found',409);
  return rows[0];
}
export async function resumeImports():Promise<void> {
  if (!pilotEnabled() || working) return;
  await query("UPDATE youtube_import_jobs SET status='PENDING' WHERE status='RUNNING' AND updated_at < NOW()-INTERVAL '10 minutes'");
  const {rows}=await query<{id:string}>("SELECT id FROM youtube_import_jobs WHERE status='PENDING' ORDER BY created_at LIMIT 1");
  if (rows[0]) void runImport(Number(rows[0].id));
}
