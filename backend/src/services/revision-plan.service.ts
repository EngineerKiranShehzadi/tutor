import {query} from '../config/database';
import {AppError} from '../middleware/errorHandler';
import {normalizeRevisionGuidance,revisionEligible} from './revision-plan-policy';
const positive=(n:number,label:string)=>{if(!Number.isSafeInteger(n)||n<1)throw new AppError('Invalid '+label,400);return n;};
const readMap=(r:any)=>({
 outcomeId:Number(r.outcome_id),code:r.code,description:r.description,
 lectureId:Number(r.lecture_id),lectureTitle:r.lecture_title,guidance:r.guidance,
 status:r.status,approvedAt:r.approved_at?.toISOString?.()??null
});
export async function listFacultyRevisionPlans(courseId:number){
 positive(courseId,'course');
 const {rows}=await query<any>(`SELECT p.*,o.code,o.description,l.title AS lecture_title FROM approved_revision_plans p
 JOIN course_learning_outcomes o ON o.id=p.outcome_id
 JOIN lectures l ON l.id=p.lecture_id WHERE o.course_id=$1 ORDER BY o.code`,[courseId]);
 return rows.map(readMap);
}
export async function upsertRevisionPlan(adminId:string,courseId:number,outcomeId:number,lectureId:number,guidance:string,approve:boolean){
 positive(courseId,'course');positive(outcomeId,'outcome');positive(lectureId,'lecture');
 let note:string;
 try{note=normalizeRevisionGuidance(guidance);}catch(e){throw new AppError((e as Error).message,400);}
 // Enforce course membership AND explicit faculty-approved lecture coverage.
 const {rows}=await query(`INSERT INTO approved_revision_plans
 (outcome_id,lecture_id,guidance,status,approved_by,approved_at,updated_at)
 SELECT o.id,l.id,$4,$5,$6,CASE WHEN $7::boolean THEN NOW() ELSE NULL END,NOW()
 FROM course_learning_outcomes o
 JOIN lecture_learning_outcomes x ON x.outcome_id=o.id
 JOIN lectures l ON l.id=x.lecture_id
 WHERE o.id=$2 AND o.course_id=$1 AND l.id=$3 AND l.course_id=$1
 AND l.archived_at IS NULL
 ON CONFLICT(outcome_id) DO UPDATE SET lecture_id=EXCLUDED.lecture_id,
 guidance=EXCLUDED.guidance,status=EXCLUDED.status,approved_by=EXCLUDED.approved_by,
 approved_at=EXCLUDED.approved_at,updated_at=NOW()
 RETURNING outcome_id`,[courseId,outcomeId,lectureId,note,approve?'APPROVED':'DRAFT',approve?adminId:null,approve]);
 if(!rows.length)throw new AppError('Select a non-archived lecture explicitly mapped to this course outcome',400);
 return listFacultyRevisionPlans(courseId);
}
export async function withdrawRevisionPlan(courseId:number,outcomeId:number){
 positive(courseId,'course');positive(outcomeId,'outcome');
 const {rowCount}=await query(`UPDATE approved_revision_plans p SET status='DRAFT',
 approved_at=NULL,updated_at=NOW() FROM course_learning_outcomes o
 WHERE p.outcome_id=o.id AND o.id=$2 AND o.course_id=$1 AND p.status='APPROVED'`,[courseId,outcomeId]);
 if(!rowCount)throw new AppError('No approved plan exists for this course outcome',404);
 return listFacultyRevisionPlans(courseId);
}
export async function myRevisionRecommendations(studentId:string,courseId:number){
 positive(courseId,'course');
 // Student ownership is enforced in SQL; no faculty-only draft guidance leaks.
 // Use only completed explicitly mapped answers and live, approved, non-archived lectures.
 const {rows}=await query<any>(`
 WITH own_evidence AS (
  SELECT m.outcome_id,COUNT(*)::int AS attempted,
   COUNT(*) FILTER(WHERE a.is_correct)::int AS correct
  FROM practice_question_outcomes m
  JOIN practice_questions q ON q.id=m.question_id
  JOIN practice_quizzes z ON z.id=q.quiz_id AND z.student_id=$2
   AND z.course_id=$1 AND z.status='COMPLETED' AND z.submitted_at IS NOT NULL
  JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
  GROUP BY m.outcome_id
 )
 SELECT p.outcome_id,o.code,o.description,p.lecture_id,l.title AS lecture_title,
 p.guidance,e.attempted,e.correct
 FROM approved_revision_plans p
 JOIN course_learning_outcomes o ON o.id=p.outcome_id AND o.course_id=$1
 JOIN lectures l ON l.id=p.lecture_id AND l.course_id=$1 AND l.archived_at IS NULL
 JOIN lecture_learning_outcomes lo ON lo.outcome_id=o.id AND lo.lecture_id=l.id
 JOIN own_evidence e ON e.outcome_id=o.id
 WHERE p.status='APPROVED'
 ORDER BY o.code`,[courseId,studentId]);
 return rows.filter(r=>revisionEligible(Number(r.attempted),Number(r.correct))).map(r=>({
  outcomeId:Number(r.outcome_id),code:r.code,description:r.description,
  lectureId:Number(r.lecture_id),lectureTitle:r.lecture_title,guidance:r.guidance,
  attempted:Number(r.attempted),correct:Number(r.correct)
 }));
}
