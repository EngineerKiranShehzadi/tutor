import pool,{query} from '../config/database';
import {AppError} from '../middleware/errorHandler';

// Stage 0 = first guided question, 1/2 = progressive hints, 3 = grounded explanation.
export type SocraticStage=0|1|2|3;
export interface SocraticState {anchorQuestion:string;stage:1|2|3}
export function nextSocraticStage(stage:SocraticStage):1|2|3|null {
 switch(stage){case 0:return 1;case 1:return 2;case 2:return 3;case 3:return null;}
}
export function socraticTurnInstructions(stage:SocraticStage):string {
 switch(stage){
  case 0:return 'First turn: ask ONE specific conceptual question about the student topic. Do not reveal the full answer. End after the question.';
  case 1:return 'The student has attempted the guided question. Use their attempt and source evidence to give ONE specific hint, then ONE follow-up question. Do not reveal the full answer yet.';
  case 2:return 'Give a stronger, source-grounded hint tied to the current study topic, then ONE check question. Do not invent a student misconception or grade their answer.';
  case 3:return 'Final bounded turn: provide the source-grounded explanation and correct conceptual reasoning. Finish with ONE brief transfer question. Do not ask the student to wait for another hint.';
 }
}
export async function getSocraticState(studentId:string,lectureId:number,sessionId:number):Promise<SocraticState|null>{
 const {rows}=await query<{anchor_question:string;next_stage:1|2|3}>(
  'SELECT anchor_question,next_stage FROM socratic_chat_state WHERE session_id=$1 AND student_id=$2 AND lecture_id=$3',
  [sessionId,studentId,lectureId]);
 return rows[0]?{anchorQuestion:rows[0].anchor_question,stage:rows[0].next_stage}:null;
}
// Commit the verified turn and its next stage in ONE transaction.
 // Session row lock serializes concurrent replies and enforces ownership.
 // No partial history on stale-stage conflict or transaction failure.
export async function saveVerifiedSocraticTurn(args:{
 studentId:string;lectureId:number;sessionId:number;anchorQuestion:string;stage:SocraticStage;
 question:string;answer:string;sourceChunkIds:number[];traceId?:string
}):Promise<number>{
 const {studentId,lectureId,sessionId,anchorQuestion,stage,question,answer,sourceChunkIds,traceId}=args;
 const next=nextSocraticStage(stage);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const {rows:ownership}=await client.query('SELECT id FROM chat_sessions WHERE id=$1 AND student_id=$2 AND lecture_id=$3 FOR UPDATE',[sessionId,studentId,lectureId]);
  if(!ownership.length)throw new AppError('Chat session not found for this lecture.',404);
  let changed=0;
  if(stage===0){
    const r=await client.query(`INSERT INTO socratic_chat_state(session_id,student_id,lecture_id,anchor_question,next_stage)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(session_id) DO NOTHING RETURNING session_id`,
      [sessionId,studentId,lectureId,anchorQuestion]);
    changed=r.rowCount??0;
  }else if(next===null){
    const r=await client.query(`DELETE FROM socratic_chat_state
      WHERE session_id=$1 AND student_id=$2 AND lecture_id=$3 AND anchor_question=$4 AND next_stage=3 RETURNING session_id`,
      [sessionId,studentId,lectureId,anchorQuestion]);
    changed=r.rowCount??0;
  }else{
    const r=await client.query(`UPDATE socratic_chat_state SET next_stage=$5,updated_at=NOW()
      WHERE session_id=$1 AND student_id=$2 AND lecture_id=$3 AND anchor_question=$4 AND next_stage=$6 RETURNING session_id`,
      [sessionId,studentId,lectureId,anchorQuestion,next,stage]);
    changed=r.rowCount??0;
  }
  if(changed!==1)throw new AppError('This Socratic turn is no longer current. Refresh the chat.',409);
  const r=await client.query<{id:number}>(`INSERT INTO chat_history
    (student_id,lecture_id,question,answer,source_chunk_ids,session_id,trace_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [studentId,lectureId,question,answer,sourceChunkIds,sessionId,traceId??null]);
  await client.query(`UPDATE chat_sessions SET updated_at=NOW(),
     title=CASE WHEN title='New Chat' THEN $3 ELSE title END
     WHERE id=$2 AND student_id=$1`,[studentId,sessionId,question.slice(0,80)]);
  await client.query('COMMIT');
  return r.rows[0].id;
 }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}
 finally{client.release();}
}
