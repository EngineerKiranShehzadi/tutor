/**
 * Real disposable-Postgres test of cross-student shared YouTube content,
 * no YouTube API calls or real embeddings/LLM credentials.
 */
import assert from 'assert/strict';
import {randomUUID} from 'crypto';
import {query} from '../config/database';
import {indexPersonalVideo, type PersonalIndexDeps} from '../services/personal-youtube-rag.service';
import {getStorageStats, getStudentStorageUsage} from '../services/youtube-storage-policy.service';
import {sweepYoutubeStorage} from '../services/youtube-storage-maintenance.service';
import {createYoutubeSession} from '../services/personal-youtube-chat.service';

const VIDEO='abcdefghijk';
const vec=Array.from({length:1024},(_,i)=>i===0?1:0);
async function main(){
  const users:string[]=[];
  try {
    for(const key of ['one','two']){
      const {rows}=await query<{id:string}>(
        "INSERT INTO users(name,email,password_hash,role,is_verified) VALUES($1,$2,'test','STUDENT',true) RETURNING id",
        ['Shared QA '+key,'shared-storage-'+key+'-'+randomUUID()+'@example.invalid']);
      users.push(rows[0].id);
    }
    const ids:number[]=[];
    for(const u of users){
      const {rows}=await query<{id:string}>(
        "INSERT INTO student_youtube_courses(student_id,playlist_id,title,status) VALUES($1,$2,'QA course','READY') RETURNING id",
        [u,'PL_shared_'+randomUUID().replace(/-/g,'')]);
      const id=Number(rows[0].id);
      ids.push(id);
      await query(
        "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position) VALUES($1,$2,'Shared public video',1)",
        [id,VIDEO]);
    }
    let embedded=0;
    const deps:PersonalIndexDeps={
      allowSharedReuse:true,
      fetchCaptions:async()=>({language:'en',cues:[
        {startMs:1000,endMs:3000,text:'Neural networks learn by adjusting their weights.'}
      ]}),
      embedBatch:async texts=>{embedded+=texts.length;return texts.map(()=>[...vec]);},
    };
    await indexPersonalVideo(ids[0],{video_id:VIDEO,title:'Shared public video',ingest_status:'PREVIEW_ONLY'},deps);
    assert.equal(embedded,1,'First unique video is embedded exactly once');
    await indexPersonalVideo(ids[1],{video_id:VIDEO,title:'Shared public video',ingest_status:'PREVIEW_ONLY'},deps);
    assert.equal(embedded,1,'Second student must reuse same stored vectors');
    const {rows:maps}=await query<{shared_content_id:string}>(
      "SELECT shared_content_id FROM student_youtube_course_videos WHERE course_id=ANY($1::bigint[]) ORDER BY course_id",
      [ids]);
    assert.equal(maps.length,2);
    assert.ok(maps[0].shared_content_id);
    assert.equal(maps[0].shared_content_id,maps[1].shared_content_id);
    const {rows:shared}=await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM youtube_shared_chunks WHERE content_id=$1',
      [maps[0].shared_content_id]);
    assert.equal(shared[0].n,1);
    const {rows:legacy}=await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_course_chunks WHERE course_id=ANY($1::bigint[])',
      [ids]);
    assert.equal(legacy[0].n,0);
    const usage=await getStudentStorageUsage(users[0]);
    assert.equal(usage.courses,1);
    assert.equal(usage.readyVideos,1);
    const stats=await getStorageStats();
    assert.ok(stats.sharedChunks>=1 && stats.reusedMappings>=2);
    const session=await createYoutubeSession(users[0],ids[0],VIDEO);
    await query(
      "INSERT INTO student_youtube_chat_messages(session_id,role,content) VALUES($1,'user','Preserve this private chat')",
      [session.id]);
    await query(
      "UPDATE student_youtube_courses SET expires_at=NOW()-INTERVAL '2 days',last_accessed_at=NOW()-INTERVAL '40 days' WHERE id=$1",
      [ids[0]]);
    const sweep=await sweepYoutubeStorage();
    assert.ok(sweep.expired>=1);
    const {rows:states}=await query<{course_id:string;ingest_status:string;shared_content_id:string|null}>(
      "SELECT course_id,ingest_status,shared_content_id FROM student_youtube_course_videos WHERE course_id=ANY($1::bigint[]) ORDER BY course_id",
      [ids]);
    assert.equal(states[0].ingest_status,'EXPIRED');
    assert.equal(states[0].shared_content_id,null);
    assert.equal(states[1].ingest_status,'READY');
    assert.equal(states[1].shared_content_id,maps[0].shared_content_id);
    const {rows:kept}=await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM student_youtube_chat_messages WHERE session_id=$1',
      [session.id]);
    assert.equal(kept[0].n,1,'Retaining chat history is mandatory');
    const {rows:stillShared}=await query<{n:number}>(
      'SELECT COUNT(*)::int AS n FROM youtube_shared_chunks WHERE content_id=$1',
      [maps[0].shared_content_id]);
    assert.equal(stillShared[0].n,1,'Shared content cannot be removed while used by another student');
    console.log('YouTube shared-content dedup, storage metrics, TTL and private chat retention passed');
  }finally{
    for(const id of users)await query('DELETE FROM users WHERE id=$1',[id]).catch(()=>undefined);
    // Test-created shared content can be orphaned on this ephemeral database.
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
