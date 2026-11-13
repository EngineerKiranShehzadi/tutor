/**
 * Real DB retrieval + RAG orchestration smoke with deterministic providers.
 * No external API calls. Verifies ownership, grounded source links and
 * rejection/no-evidence behavior, on a disposable PostgreSQL database.
 */
import assert from 'assert/strict';
import { randomUUID } from 'crypto';
import { query } from '../config/database';
import { askPersonalRag, indexPersonalVideo, type PersonalIndexDeps } from '../services/personal-youtube-rag.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import type { QnaChunk } from '../types';

const videoId='abcdefghijk';
const v=Array.from({length:1024},(_,i)=>i===0?1:0);
const indexDeps:PersonalIndexDeps={
  fetchCaptions:async()=>({language:'en',cues:[
    {startMs:1500,endMs:3000,text:'A neural network learns patterns from examples.'},
    {startMs:3500,endMs:6500,text:'Training adjusts the weights.'},
  ]}),
  embedBatch:async texts=>texts.map(()=>[...v]),
};

async function main() {
  const users:string[]=[];
  try {
    for(const label of ['A','B']){
      const r=await query<{id:string}>(
        "INSERT INTO users(name,email,password_hash,role,is_verified) VALUES($1,$2,'test','STUDENT',true) RETURNING id",
        ['Private QA '+label,'private-qa-'+label+'-'+randomUUID()+'@example.invalid']);
      users.push(r.rows[0].id);
    }
    const created=await query<{id:string}>(
      "INSERT INTO student_youtube_courses(student_id,playlist_id,title,status) VALUES($1,$2,$3,'PREVIEW_ONLY') RETURNING id",
      [users[0],'PL_qa_test_000000001','Neural Network Pilot']);
    const courseId=Number(created.rows[0].id);
    await query(
      "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status) VALUES($1,$2,$3,1,'PREVIEW_ONLY')",
      [courseId,videoId,'Neural Network Introduction']);
    await indexPersonalVideo(courseId,{video_id:videoId,title:'Neural Network Introduction',ingest_status:'PREVIEW_ONLY'},indexDeps);
    await query("UPDATE student_youtube_courses SET status='READY' WHERE id=$1",[courseId]);

    let generated=0,reranked=0,verified=0;
    const deps={
      embedQuery:async()=>[...v],
      quota:async()=>undefined,
      inputGuard:async(text:string)=>({action:'ALLOW' as const,sanitizedInput:text}),
      rerank:async(_question:string,chunks:QnaChunk[])=>{
        reranked++;
        return chunks.map(c=>({...c,rerankScore:0.99}));
      },
      generate:async(_question:string,chunks:QnaChunk[])=>{
        generated++;
        assert.ok(chunks.some(c=>c.chunk_text.includes('neural network')));
        return 'A neural network learns patterns from examples.';
      },
      outputGuard:async(_params:any)=>{
        verified++;
        return {finalAnswer:'A neural network learns patterns from examples.',verified:true,verificationUnavailable:false};
      },
    };
    const answer=await askPersonalRag(users[0],courseId,'How does a neural network learn?',deps as any);
    assert.match(answer.answer,/learns patterns/);
    assert.equal(answer.sources.length,1);
    assert.equal(answer.sources[0].videoId,videoId);
    assert.equal(answer.sources[0].startTime,'00:00:01.500');
    assert.equal(answer.sources[0].endTime,'00:00:06.500');
    assert.equal(answer.sources[0].url,'https://www.youtube.com/watch?v=abcdefghijk&t=1s');
    assert.equal(generated,1);
    assert.equal(reranked,1);
    assert.equal(verified,1);

    await assert.rejects(
      askPersonalRag(users[1],courseId,'How does a neural network learn?',deps as any),
      /Personal course not found/);
    assert.equal(generated,1,'Cross-student request must fail before generation');

    const noEvidence=await askPersonalRag(users[0],courseId,'Explain quantum gravity',{
      ...deps,rerank:async()=>[],
    } as any);
    assert.equal(noEvidence.sources.length,0);
    assert.match(noEvidence.answer,/could not find/);
    assert.equal(generated,1,'No evidence must not trigger generation');

    const rejected=await assert.rejects(
      askPersonalRag(users[0],courseId,'What is this?',{
        ...deps,inputGuard:async()=>({action:'REJECT',reason:'PROMPT_INJECTION'}),
      } as any),
      /could not be processed/);
    assert.equal(generated,1,'Rejected input must not trigger generation');

    // Scoped lecture retrieval must never mix evidence from another video
    // even when both are in the same student's private course.
    const otherVideo='lmnopqrstuv';
    await query(
      "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status) VALUES($1,$2,$3,2,'PREVIEW_ONLY')",
      [courseId,otherVideo,'Unrelated Lecture']
    );
    await indexPersonalVideo(courseId,{video_id:otherVideo,title:'Unrelated Lecture',ingest_status:'PREVIEW_ONLY'},{
      ...indexDeps,
      fetchCaptions: async()=>({language:'en',cues:[
        {startMs:1000,endMs:2500,text:'This is an unrelated optimization lecture.'}
      ]})
    });
    const onlyThisVideo=await askPersonalRag(users[0],courseId,
      'How does a neural network learn?',{
        ...deps,
        generate: async(_q:string,chunks:QnaChunk[])=>{
          assert.ok(chunks.every(c=>(c as any).video_id===videoId),'Other video leaked into evidence');
          return 'A neural network learns from examples.';
        },
      } as any,videoId);
    assert.ok(onlyThisVideo.sources.length>0);
    assert.ok(onlyThisVideo.sources.every(s=>s.videoId===videoId));
    await assert.rejects(askPersonalRag(users[0],courseId,'Explain neural networks',deps as any,
      'not-a-video'),/Invalid video ID/);

    const db=await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_course_chunks WHERE course_id=$1 AND embedding_model_version=$2',
      [courseId,EMBEDDING_MODEL_VERSION]);
    assert.equal(db.rows[0].n,2);
    console.log('Personal YouTube Q&A DB integration passed (grounding, citations, owner isolation, no-evidence, input guard)');
  } finally {
    for(const id of users) await query('DELETE FROM users WHERE id=$1',[id]).catch(()=>undefined);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
