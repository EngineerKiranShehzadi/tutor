import {strict as assert} from 'assert';
import pool,{query} from '../config/database';
import {getSocraticState,saveVerifiedSocraticTurn} from '../services/socratic-state.service';

// Refuse to connect to production or any non-disposable test database.
if(process.env.NODE_ENV!=='test'||process.env.DB_NAME!=='outcomes_test'||
  !['localhost','127.0.0.1'].includes(process.env.DB_HOST||'')){
  throw new Error('Refusing Socratic DB test outside isolated localhost outcomes_test');
}
const student='00000000-0000-4000-8000-000000000091';
const other='00000000-0000-4000-8000-000000000092';
const lecture=99091,course=99091,session=99091;
const anchor='Explain precision in the lecture context';
const savedBefore=async()=>{
 const r=await query<{n:string}>('SELECT COUNT(*)::text AS n FROM chat_history WHERE session_id=$1',[session]);
 return Number(r.rows[0].n);
};
async function run(){
 await query(`INSERT INTO users(id,name,email,password_hash) VALUES
 ($1,'Socratic E2E Student','socratic-e2e-a@example.invalid','offline'),
 ($2,'Other Student','socratic-e2e-b@example.invalid','offline')`,[student,other]);
 await query('INSERT INTO courses(id,title) VALUES($1,$2)',[course,'Socratic transaction E2E']);
 await query('INSERT INTO lectures(id,course_id,title,youtube_url) VALUES($1,$2,$3,$4)',
  [lecture,course,'Precision','https://www.youtube.com/watch?v=abc123def45']);
 await query('INSERT INTO chat_sessions(id,student_id,lecture_id,title) VALUES($1,$2,$3,$4)',
  [session,student,lecture,'New Chat']);
 assert.equal(await getSocraticState(student,lecture,session),null);
 assert.equal(await getSocraticState(other,lecture,session),null);
 const first=await saveVerifiedSocraticTurn({studentId:student,lectureId:lecture,sessionId:session,
  anchorQuestion:anchor,stage:0,question:anchor,answer:'Which numerator is used?',sourceChunkIds:[]});
 assert.ok(first>0);
 assert.deepEqual(await getSocraticState(student,lecture,session),{anchorQuestion:anchor,stage:1});
 assert.equal(await getSocraticState(other,lecture,session),null);
 assert.equal(await savedBefore(),1);
 // Repeat stale stage must fail atomically: no second history write.
 await assert.rejects(saveVerifiedSocraticTurn({studentId:student,lectureId:lecture,sessionId:session,
  anchorQuestion:anchor,stage:0,question:anchor,answer:'Duplicate answer',sourceChunkIds:[]}),/no longer current/);
 assert.equal(await savedBefore(),1);
 await assert.rejects(saveVerifiedSocraticTurn({studentId:other,lectureId:lecture,sessionId:session,
  anchorQuestion:anchor,stage:1,question:'Wrong owner',answer:'No',sourceChunkIds:[]}),/not found/);
 assert.equal(await savedBefore(),1);
 // A database failure after advancing the stage must roll back both state and history.
 await assert.rejects(saveVerifiedSocraticTurn({studentId:student,lectureId:lecture,sessionId:session,
  anchorQuestion:anchor,stage:1,question:null as unknown as string,
  answer:'This history write must fail',sourceChunkIds:[]}),/null value|not-null constraint/i);
 assert.deepEqual(await getSocraticState(student,lecture,session),{anchorQuestion:anchor,stage:1},
  'A failed history write must not consume the next guided hint');
 assert.equal(await savedBefore(),1,'A failed history write must leave no partial chat record');
 for(const stage of [1,2,3] as const){
  await saveVerifiedSocraticTurn({studentId:student,lectureId:lecture,sessionId:session,
   anchorQuestion:anchor,stage,question:'My attempt '+stage,answer:'Guided reply '+stage,sourceChunkIds:[]});
 }
 assert.equal(await getSocraticState(student,lecture,session),null);
 assert.equal(await savedBefore(),4);
 const titles=await query<{title:string}>('SELECT title FROM chat_sessions WHERE id=$1',[session]);
 assert.equal(titles.rows[0].title,anchor.slice(0,80));
 console.log('Socratic transaction integration passed (4 stages, owner lock, stale rollback, final close).');
}
async function main(){
 try{await run();}
 finally{
  // Only fake fixture rows on a verified disposable database.
  await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[student,other]]);
  await query('DELETE FROM lectures WHERE id=$1',[lecture]);
  await query('DELETE FROM courses WHERE id=$1',[course]);
  await pool.end();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
