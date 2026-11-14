import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
const id=(v:number)=>{if(!Number.isSafeInteger(v)||v<1)throw new AppError('Invalid ID',400);return v;};
export async function getMisconceptions(courseId:number){
 id(courseId);
 const {rows}=await query<any>(`SELECT m.id,m.outcome_id,m.code,m.description FROM learning_misconceptions m
 JOIN course_learning_outcomes o ON o.id=m.outcome_id WHERE o.course_id=$1 ORDER BY o.code,m.code`,[courseId]);
 return rows.map(r=>({id:Number(r.id),outcomeId:Number(r.outcome_id),code:r.code,description:r.description}));
}
export async function createMisconception(courseId:number,outcomeId:number,code:string,description:string){
 id(courseId);id(outcomeId);
 const c=(code||'').trim().toUpperCase(),d=(description||'').trim();
 if(!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(c)||d.length<8||d.length>600)
  throw new AppError('Invalid misconception code or description',400);
 try{
  const r=await query(`INSERT INTO learning_misconceptions(outcome_id,code,description)
   SELECT id,$3,$4 FROM course_learning_outcomes WHERE id=$2 AND course_id=$1 RETURNING id`,
   [courseId,outcomeId,c,d]);
  if(!r.rows.length)throw new AppError('Course outcome not found',404);
 }catch(e:any){if(e?.code==='23505')throw new AppError('Misconception code already exists',409);throw e;}
 return getMisconceptions(courseId);
}
export async function setDistractorMisconception(courseId:number,questionId:number,optionIndex:number,misconceptionId:number|null){
 id(courseId);id(questionId);
 if(!Number.isInteger(optionIndex)||optionIndex<0||optionIndex>3)throw new AppError('Invalid option index',400);
 if(misconceptionId!==null)id(misconceptionId);
 // Check question ownership, approved CLO mapping and correct option before writing.
 const {rows}=await query<any>(`SELECT q.correct_index FROM practice_questions q
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.course_id=$1
 JOIN practice_question_outcomes m ON m.question_id=q.id WHERE q.id=$2`,[courseId,questionId]);
 if(!rows.length)throw new AppError('Map question to an approved CLO first',400);
 if(rows[0].correct_index===optionIndex)throw new AppError('Cannot tag the correct option',400);
 if(misconceptionId===null){
  await query('DELETE FROM practice_distractor_misconceptions WHERE question_id=$1 AND selected_index=$2',[questionId,optionIndex]);
  return true;
 }
 // Composite database FKs guarantee that question CLO and misconception CLO match.
 const r=await query(`INSERT INTO practice_distractor_misconceptions(question_id,selected_index,outcome_id,misconception_id)
 SELECT q.id,$3,qo.outcome_id,m.id FROM practice_questions q
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.course_id=$1
 JOIN practice_question_outcomes qo ON qo.question_id=q.id
 JOIN learning_misconceptions m ON m.outcome_id=qo.outcome_id AND m.id=$4
 WHERE q.id=$2 AND q.correct_index<>$3
 ON CONFLICT(question_id,selected_index) DO UPDATE SET
 outcome_id=EXCLUDED.outcome_id,misconception_id=EXCLUDED.misconception_id,mapped_at=NOW()
 RETURNING question_id`,[courseId,questionId,optionIndex,misconceptionId]);
 if(!r.rows.length)throw new AppError('Misconception and question must share one approved CLO',400);
 return true;
}
export async function getDistractorReview(courseId:number,limit=50){
 id(courseId);
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new AppError('Invalid limit',400);
 const {rows}=await query<any>(`SELECT q.id,q.question,q.options,q.correct_index,qo.outcome_id,
 COALESCE(jsonb_agg(jsonb_build_object('optionIndex',d.selected_index,'misconceptionId',d.misconception_id))
 FILTER(WHERE d.question_id IS NOT NULL),'[]'::jsonb) AS mappings
 FROM practice_questions q JOIN practice_quizzes z ON z.id=q.quiz_id
 LEFT JOIN practice_question_outcomes qo ON qo.question_id=q.id
 LEFT JOIN practice_distractor_misconceptions d ON d.question_id=q.id
 WHERE z.course_id=$1 GROUP BY q.id,qo.outcome_id ORDER BY q.id DESC LIMIT $2`,[courseId,limit]);
 return rows.map(r=>({questionId:Number(r.id),question:r.question,options:r.options as string[],
 correctIndex:r.correct_index,outcomeId:r.outcome_id===null?null:Number(r.outcome_id),
 mappings:(r.mappings||[]).map((m:any)=>({optionIndex:m.optionIndex,misconceptionId:Number(m.misconceptionId)}))}));
}
export async function myMisconceptionEvidence(studentId:string,courseId:number){
 id(courseId);
 const {rows}=await query<any>(`SELECT m.id,m.outcome_id,m.code,m.description,o.code AS outcome_code,
 COUNT(a.question_id)::int AS occurrences,
 COUNT(DISTINCT z.id) FILTER(WHERE a.question_id IS NOT NULL)::int AS attempts,
 MAX(z.submitted_at) FILTER(WHERE a.question_id IS NOT NULL) AS last_seen
 FROM learning_misconceptions m
 JOIN course_learning_outcomes o ON o.id=m.outcome_id
 LEFT JOIN practice_distractor_misconceptions d ON d.misconception_id=m.id
 LEFT JOIN practice_questions q ON q.id=d.question_id
 LEFT JOIN practice_quizzes z ON z.id=q.quiz_id AND z.student_id=$2 AND z.course_id=$1 AND z.status='COMPLETED'
 LEFT JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
 AND a.selected_index=d.selected_index AND a.is_correct=FALSE
 WHERE o.course_id=$1 GROUP BY m.id,o.code
 HAVING COUNT(a.question_id)>0 ORDER BY occurrences DESC,m.code`,[courseId,studentId]);
 return rows.map(r=>({id:Number(r.id),outcomeId:Number(r.outcome_id),outcomeCode:r.outcome_code,
 code:r.code,description:r.description,occurrences:Number(r.occurrences),attempts:Number(r.attempts),
 repeated:Number(r.occurrences)>=2,lastSeen:r.last_seen?.toISOString?.()??null}));
}
export async function myOutcomeTimeline(studentId:string,courseId:number){
 id(courseId);
 const {rows}=await query<any>(`SELECT o.id AS outcome_id,o.code,z.id AS quiz_id,z.submitted_at,
 COUNT(a.question_id)::int AS attempted,
 COUNT(a.question_id) FILTER(WHERE a.is_correct)::int AS correct
 FROM course_learning_outcomes o
 JOIN practice_question_outcomes qo ON qo.outcome_id=o.id
 JOIN practice_questions q ON q.id=qo.question_id
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.course_id=$1 AND z.student_id=$2 AND z.status='COMPLETED'
 JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
 WHERE o.course_id=$1
 GROUP BY o.id,z.id,z.submitted_at ORDER BY z.submitted_at DESC,z.id DESC LIMIT 200`,[courseId,studentId]);
 return rows.map(r=>({outcomeId:Number(r.outcome_id),code:r.code,quizId:Number(r.quiz_id),
 submittedAt:r.submitted_at?.toISOString?.()??'',attempted:Number(r.attempted),correct:Number(r.correct)}));
}
