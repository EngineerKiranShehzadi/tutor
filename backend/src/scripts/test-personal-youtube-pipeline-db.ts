/**
 * Ephemeral PostgreSQL integration: one private course, exactly two captioned
 * videos, real chunk conversion and pgvector writes, deterministic embeddings.
 * No YouTube network, Python transcript API, LLM, or embedding service calls.
 */
import assert from 'assert/strict';
import { randomUUID } from 'crypto';
import { query } from '../config/database';
import { indexPersonalVideo, type PersonalIndexDeps } from '../services/personal-youtube-rag.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';

interface Row { id: string }
const IDS = ['abcdefghijk','lmnopqrstuv'];
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
const deps: PersonalIndexDeps = {
  fetchCaptions: async videoId => ({
    language: 'hi',
    cues: [
      { startMs: 1000, endMs: 3500, text: videoId === IDS[0] ? 'नमस्ते, neural networks' : 'Deep learning introduction' },
      { startMs: 4000, endMs: 6500, text: 'A model learns patterns from data.' },
    ],
  }),
  embedBatch: async texts => texts.map(() => [...vector]),
};

async function main() {
  const suffix = randomUUID();
  const userIds: string[] = [];
  try {
    for (const label of ['A','B']) {
      const { rows } = await query<Row>(
        'INSERT INTO users(name,email,password_hash,role,is_verified) VALUES($1,$2,$3,$4,$5) RETURNING id',
        ['Private YouTube '+label,'youtube-pipeline-'+label+'-'+suffix+'@example.invalid','test-only','STUDENT',true]);
      userIds.push(rows[0].id);
    }
    const { rows: courses } = await query<Row>(
      "INSERT INTO student_youtube_courses(student_id,playlist_id,title,status) VALUES($1,$2,$3,'PREVIEW_ONLY') RETURNING id",
      [userIds[0],'PL_personal_pilot_0001','Private Deep Learning']);
    const courseId = Number(courses[0].id);
    for (let i=0;i<IDS.length;i++) {
      await query(
        "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status) VALUES($1,$2,$3,$4,'PREVIEW_ONLY')",
        [courseId,IDS[i],'Test video '+(i+1),i+1]);
      await indexPersonalVideo(courseId,{video_id:IDS[i],title:'Test video '+(i+1),ingest_status:'PREVIEW_ONLY'},deps);
    }

    const { rows: stored } = await query<{
      video_id: string; start_time: string; end_time: string;
      answer: string; embedding_model_version: string; dims: number;
    }>(
      'SELECT video_id,start_time,end_time,answer,embedding_model_version,vector_dims(local_embedding) AS dims '+
      'FROM student_youtube_course_chunks WHERE course_id=$1 ORDER BY video_id,chunk_index',
      [courseId]);
    assert.equal(stored.length,2,'Two videos should produce exactly two indexed chunks');
    assert.deepEqual(stored.map(r=>r.video_id),IDS);
    for (const row of stored) {
      assert.equal(row.start_time,'00:00:01.000');
      assert.equal(row.end_time,'00:00:06.500');
      assert.match(row.answer,/patterns from data/);
      assert.equal(row.embedding_model_version,EMBEDDING_MODEL_VERSION);
      assert.equal(row.dims,1024);
    }
    // Reindex must replace, not duplicate, the same video's chunks.
    await indexPersonalVideo(courseId,{video_id:IDS[0],title:'Test video 1',ingest_status:'READY'},deps);
    const count = await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_course_chunks WHERE course_id=$1',[courseId]);
    assert.equal(count.rows[0].n,2,'Reindex should be idempotent');

    // A failed embedding must leave the previous live chunks intact.
    await assert.rejects(
      indexPersonalVideo(courseId,{video_id:IDS[0],title:'Test video 1',ingest_status:'READY'},{
        ...deps,embedBatch: async texts => texts.map(() => [1,2,3]),
      }),
      /dimension mismatch/
    );
    const after = await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_course_chunks WHERE course_id=$1',[courseId]);
    assert.equal(after.rows[0].n,2,'Failed reindex must preserve previous chunks');

    // Exact owner-scoped evidence query used by personal RAG.
    const crossOwner = await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_course_chunks k '+
      'JOIN student_youtube_courses c ON c.id=k.course_id '+
      'WHERE c.id=$1 AND c.student_id=$2',
      [courseId,userIds[1]]);
    assert.equal(crossOwner.rows[0].n,0,'Student B cannot retrieve student A evidence');

    const shared = await query<{n:number}>(
      "SELECT COUNT(*)::int AS n FROM lecture_qna_chunks WHERE answer LIKE '%A model learns patterns from data.%'");
    assert.equal(shared.rows[0].n,0,'Private transcripts must not leak to shared lecture chunks');

    console.log('Personal YouTube pipeline DB integration passed (1 course, 2 videos, pgvector, isolation, retry)');
  } finally {
    // The CI database is ephemeral, but clean up fixtures even after failure.
    for (const id of userIds) await query('DELETE FROM users WHERE id=$1',[id]).catch(()=>undefined);
  }
}

main().catch(e => { console.error(e); process.exitCode=1; });
