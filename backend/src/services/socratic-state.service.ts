import {query} from '../config/database';
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
export async function advanceSocraticState(args:{studentId:string;lectureId:number;sessionId:number;anchorQuestion:string;stage:SocraticStage}):Promise<void>{
 const {studentId,lectureId,sessionId,anchorQuestion,stage}=args;
 const next=nextSocraticStage(stage);
 if(stage===0){
  // Concurrent first requests cannot replace an already started topic.
  const r=await query(`INSERT INTO socratic_chat_state(session_id,student_id,lecture_id,anchor_question,next_stage)
    SELECT id,$2,$3,$4,1 FROM chat_sessions WHERE id=$1 AND student_id=$2 AND lecture_id=$3
    ON CONFLICT(session_id) DO NOTHING RETURNING session_id`,[sessionId,studentId,lectureId,anchorQuestion]);
  if(!r.rows.length)throw new AppError('Socratic topic changed. Open a new chat to start over.',409);
 }else if(next===null){
  const r=await query('DELETE FROM socratic_chat_state WHERE session_id=$1 AND student_id=$2 AND lecture_id=$3 AND next_stage=3 AND anchor_question=$4 RETURNING session_id',
   [sessionId,studentId,lectureId,anchorQuestion]);
  if(!r.rows.length)throw new AppError('Socratic topic changed. Refresh this chat.',409);
 }else{
  const r=await query(`UPDATE socratic_chat_state SET next_stage=$5,updated_at=NOW()
    WHERE session_id=$1 AND student_id=$2 AND lecture_id=$3 AND anchor_question=$4 AND next_stage=$6
    RETURNING session_id`,[sessionId,studentId,lectureId,anchorQuestion,next,stage]);
  if(!r.rows.length)throw new AppError('Socratic topic changed. Refresh this chat.',409);
 }
}
