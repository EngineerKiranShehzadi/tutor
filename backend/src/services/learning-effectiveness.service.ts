import {query} from '../config/database';
import {AppError} from '../middleware/errorHandler';
import {observedChange,type ProgressAssessment} from './learning-effectiveness-policy';
interface Row {
 outcome_id:number;code:string;description:string;
 quiz_id:string;attempted:number;correct:number;submitted_at:Date|string;
}
// Read only completed, self-owned quiz answers and faculty-approved CLO mappings.
// Do NOT call this causal 'AI impact': two naturally occurring quiz forms are
// not confirmed equivalent and may differ in item difficulty, time or exposure.
export async function myObservedLearningProgress(studentId:string,courseId:number){
 if(!Number.isSafeInteger(courseId)||courseId<1)throw new AppError('Invalid course',400);
 const {rows}=await query<Row>(`
 SELECT o.id AS outcome_id,o.code,o.description,z.id::text AS quiz_id,
   COUNT(a.question_id)::int AS attempted,
   COUNT(a.question_id) FILTER(WHERE a.is_correct)::int AS correct,
   z.submitted_at
 FROM course_learning_outcomes o
 JOIN practice_question_outcomes m ON m.outcome_id=o.id
 JOIN practice_questions q ON q.id=m.question_id
 JOIN practice_quizzes z ON z.id=q.quiz_id AND z.student_id=$2 AND z.course_id=$1
   AND z.status='COMPLETED' AND z.submitted_at IS NOT NULL
 JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
 WHERE o.course_id=$1
 GROUP BY o.id,z.id,z.submitted_at ORDER BY o.code,z.submitted_at,z.id`,[courseId,studentId]);
 const grouped=new Map<number,{code:string;description:string;quizzes:ProgressAssessment[]}>();
 for(const r of rows){
  const k=Number(r.outcome_id),old=grouped.get(k)||{code:r.code,description:r.description,quizzes:[]};
  old.quizzes.push({quizId:Number(r.quiz_id),attempted:Number(r.attempted),correct:Number(r.correct),
   submittedAt:typeof r.submitted_at==='string'?r.submitted_at:r.submitted_at.toISOString()});
  grouped.set(k,old);
 }
 return [...grouped.entries()].map(([outcomeId,row])=>{
  const change=observedChange(row.quizzes);
  return {outcomeId,code:row.code,description:row.description,
   eligibleQuizCount:row.quizzes.filter(r=>r.attempted>=3).length,
   firstQuizId:change?.first.quizId??null,latestQuizId:change?.latest.quizId??null,
   firstPercent:change?.firstPercent??null,latestPercent:change?.latestPercent??null,
   changePoints:change?.changePoints??null,
   firstSubmittedAt:change?.first.submittedAt??null,latestSubmittedAt:change?.latest.submittedAt??null,
   interpretation:change?'OBSERVED_NOT_CAUSAL':'INSUFFICIENT_COMPARABLE_QUIZZES'};
 });
}
