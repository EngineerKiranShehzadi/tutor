/**
 * Real Postgres isolation test for student YouTube chat sessions.
 * Uses throwaway account records. No YouTube, embeddings, or LLM calls.
 */
import assert from 'assert/strict';
import {randomUUID} from 'crypto';
import {query} from '../config/database';
import {
 createYoutubeSession,listYoutubeSessions,readYoutubeSession,
 renameYoutubeSession,removeYoutubeSession
} from '../services/personal-youtube-chat.service';

const VIDEO='abcdefghijk';
async function main(){
  const users:string[]=[];
  try{
    for(const mark of ['A','B']){
      const {rows}=await query<{id:string}>(
       "INSERT INTO users(name,email,password_hash,role,is_verified) VALUES($1,$2,'test','STUDENT',true) RETURNING id",
       ['Private Chat '+mark,'private-chat-'+mark+'-'+randomUUID()+'@example.invalid']);
      users.push(rows[0].id);
    }
    const {rows:cr}=await query<{id:string}>(
      "INSERT INTO student_youtube_courses(student_id,playlist_id,title,status) VALUES($1,$2,$3,'READY') RETURNING id",
      [users[0],'PL_private_chat_testing_1','Private course']);
    const courseId=Number(cr[0].id);
    await query(
     "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status) VALUES($1,$2,'Lesson one',1,'READY')",
     [courseId,VIDEO]);
    await query(
     "INSERT INTO student_youtube_course_videos(course_id,video_id,title,position,ingest_status) VALUES($1,$2,'Lesson two',2,'FAILED')",
     [courseId,'lmnopqrstuv']);
    const session=await createYoutubeSession(users[0],courseId,VIDEO);
    const sid=Number(session.id);
    assert.equal((await listYoutubeSessions(users[0],courseId,VIDEO)).length,1);
    assert.equal((await readYoutubeSession(users[0],courseId,sid)).messages.length,0);
    await renameYoutubeSession(users[0],courseId,sid,'Neuron basics');
    assert.equal((await listYoutubeSessions(users[0],courseId,VIDEO))[0].title,'Neuron basics');
    await assert.rejects(listYoutubeSessions(users[1],courseId,VIDEO),/Course not found/);
    await assert.rejects(readYoutubeSession(users[1],courseId,sid),/Chat not found/);
    await assert.rejects(renameYoutubeSession(users[1],courseId,sid,'Stolen'),/Chat not found/);
    await assert.rejects(removeYoutubeSession(users[1],courseId,sid),/Chat not found/);
    await assert.rejects(createYoutubeSession(users[1],courseId,VIDEO),/not ready or not owned/);
    await assert.rejects(createYoutubeSession(users[0],courseId,'lmnopqrstuv'),/not ready or not owned/);
    assert.equal((await readYoutubeSession(users[0],courseId,sid)).session.video_id,VIDEO);
    await removeYoutubeSession(users[0],courseId,sid);
    await assert.rejects(readYoutubeSession(users[0],courseId,sid),/Chat not found/);
    console.log('Private YouTube chat sessions DB isolation passed');
  }finally{
    for(const userId of users)await query('DELETE FROM users WHERE id=$1',[userId]).catch(()=>{});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
