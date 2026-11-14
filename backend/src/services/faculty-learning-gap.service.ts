import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { classifyFacultyGap,facultyGapAction,MIN_ASSESSED_STUDENTS } from './faculty-learning-gap-policy';

interface Row {
  id:string;code:string;description:string;
  mapped_questions:number;lecture_ids:number[]|null;
  assessed_students:number;eligible_students:number;revision_students:number;
  answered:number;correct:number;
}
// Query aggregated evidence inside PostgreSQL, never send students' identities.
// Cross-student signals exist only for approved question-CLO mappings and completed quizzes.
export async function facultyLearningGaps(courseId:number){
 if(!Number.isSafeInteger(courseId)||courseId<1)throw new AppError('Invalid course',400);
 const {rows}=await query<Row>(`
 WITH question_map AS (
   SELECT m.outcome_id, COUNT(*)::int AS mapped_questions
   FROM practice_question_outcomes m
   JOIN practice_questions q ON q.id=m.question_id
   JOIN practice_quizzes z ON z.id=q.quiz_id
   WHERE z.course_id=$1 GROUP BY m.outcome_id
 ),
 per_student AS (
   SELECT m.outcome_id,z.student_id,
     COUNT(*)::int AS attempted,
     COUNT(*) FILTER (WHERE a.is_correct)::int AS correct
   FROM practice_question_outcomes m
   JOIN practice_questions q ON q.id=m.question_id
   JOIN practice_quizzes z ON z.id=q.quiz_id
      AND z.course_id=$1 AND z.status='COMPLETED' AND z.submitted_at IS NOT NULL
   JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
   GROUP BY m.outcome_id,z.student_id
 ),
 cohort AS (
   SELECT outcome_id,
     COUNT(*)::int AS assessed_students,
     COUNT(*) FILTER(WHERE attempted>=3)::int AS eligible_students,
     COUNT(*) FILTER(WHERE attempted>=3 AND correct::numeric/NULLIF(attempted,0)<0.6)::int AS revision_students,
     COALESCE(SUM(attempted),0)::int AS answered,
     COALESCE(SUM(correct),0)::int AS correct
   FROM per_student GROUP BY outcome_id
 )
 SELECT o.id::text AS id,o.code,o.description,
   COALESCE(qm.mapped_questions,0)::int AS mapped_questions,
   (SELECT COALESCE(array_agg(lo.lecture_id ORDER BY lo.lecture_id), ARRAY[]::int[])
     FROM lecture_learning_outcomes lo WHERE lo.outcome_id=o.id) AS lecture_ids,
   COALESCE(c.assessed_students,0)::int AS assessed_students,
   COALESCE(c.eligible_students,0)::int AS eligible_students,
   COALESCE(c.revision_students,0)::int AS revision_students,
   COALESCE(c.answered,0)::int AS answered,
   COALESCE(c.correct,0)::int AS correct
 FROM course_learning_outcomes o
 LEFT JOIN question_map qm ON qm.outcome_id=o.id
 LEFT JOIN cohort c ON c.outcome_id=o.id
 WHERE o.course_id=$1
 ORDER BY o.code
 `,[courseId]);
 return rows.map(r=>{
  const mappedQuestions=Number(r.mapped_questions);
  const assessedStudents=Number(r.assessed_students);
  const eligibleStudents=Number(r.eligible_students);
  const revisionStudents=Number(r.revision_students);
  const lectureIds=(r.lecture_ids||[]).map(Number);
  const status=classifyFacultyGap(mappedQuestions,eligibleStudents,revisionStudents);
  const sufficient=eligibleStudents>=MIN_ASSESSED_STUDENTS&&mappedQuestions>0;
  return {
   outcomeId:Number(r.id),code:r.code,description:r.description,mappedQuestions,
   // Show counts only for a sufficiently sized cohort; no individual records or identities.
   assessedStudents:sufficient?assessedStudents:null,
   eligibleStudents:sufficient?eligibleStudents:null,
   revisionStudents:sufficient?revisionStudents:null,
   answerAccuracyPercent:sufficient && Number(r.answered)>0
     ?Math.round(Number(r.correct)*100/Number(r.answered)):null,
   revisionPercent:sufficient?Math.round(revisionStudents*100/eligibleStudents):null,
   lectureIds,status,recommendation:facultyGapAction(status,lectureIds.length>0)
  };
 });
}
