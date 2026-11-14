import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';

// Mastery is NEVER inferred from chat volume or a lecture-level association.
// Only faculty-tagged, submitted, deterministically graded questions count.
export interface LearningOutcome {
  id: number; courseId: number; code: string; description: string;
  externalGuid: string | null; lectureIds: number[];
}
const positive = (n: number, name: string) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('Invalid ' + name, 400);
  return n;
};
const normalizeCode = (v: string) => {
  const code = (v || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code)) throw new AppError('Use 1–32 letters, numbers, dots, dashes or underscores for CLO code', 400);
  return code;
};
const normalizeDescription = (v: string) => {
  const d = (v || '').trim();
  if (d.length < 5 || d.length > 1000) throw new AppError('Outcome description must be 5–1000 characters', 400);
  return d;
};
const map = (r: any): LearningOutcome => ({
  id: Number(r.id), courseId: Number(r.course_id), code: r.code, description: r.description,
  externalGuid: r.external_guid || null, lectureIds: (r.lecture_ids || []).map(Number)
});
export async function listCourseOutcomes(courseId: number): Promise<LearningOutcome[]> {
  positive(courseId, 'course');
  const { rows } = await query<any>(
    `SELECT o.*, COALESCE(array_agg(lo.lecture_id ORDER BY lo.lecture_id)
      FILTER (WHERE lo.lecture_id IS NOT NULL), ARRAY[]::int[]) AS lecture_ids
      FROM course_learning_outcomes o
      LEFT JOIN lecture_learning_outcomes lo ON lo.outcome_id=o.id
      WHERE o.course_id=$1 GROUP BY o.id ORDER BY o.code`, [courseId]);
  return rows.map(map);
}
export async function createCourseOutcome(courseId: number, code: string, description: string) {
  positive(courseId, 'course');
  const course = await query('SELECT 1 FROM courses WHERE id=$1', [courseId]);
  if (!course.rows.length) throw new AppError('Course not found', 404);
  try {
    await query(`INSERT INTO course_learning_outcomes(course_id,code,description)
      VALUES($1,$2,$3)`, [courseId,normalizeCode(code),normalizeDescription(description)]);
  } catch (err: any) {
    if (err?.code === '23505') throw new AppError('Outcome code already exists for this course', 409);
    throw err;
  }
  return listCourseOutcomes(courseId);
}
export async function updateCourseOutcome(outcomeId: number, description: string) {
  positive(outcomeId, 'outcome');
  const { rows } = await query<any>(
    `UPDATE course_learning_outcomes SET description=$2,updated_at=NOW()
      WHERE id=$1 RETURNING course_id`, [outcomeId,normalizeDescription(description)]);
  if (!rows.length) throw new AppError('Outcome not found', 404);
  return listCourseOutcomes(Number(rows[0].course_id));
}
export async function setLectureOutcome(courseId: number, lectureId: number, outcomeId: number, selected: boolean) {
  positive(courseId,'course'); positive(lectureId,'lecture'); positive(outcomeId,'outcome');
  const {rows} = await query<any>(
    `SELECT l.id FROM lectures l JOIN course_learning_outcomes o ON o.course_id=l.course_id
      WHERE l.id=$1 AND l.course_id=$2 AND o.id=$3`, [lectureId,courseId,outcomeId]);
  if(!rows.length)throw new AppError('Lecture and CLO must belong to the same course', 400);
  if(selected) await query(
    'INSERT INTO lecture_learning_outcomes(lecture_id,outcome_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [lectureId,outcomeId]);
  else await query('DELETE FROM lecture_learning_outcomes WHERE lecture_id=$1 AND outcome_id=$2',[lectureId,outcomeId]);
  return listCourseOutcomes(courseId);
}
export async function mapQuestionOutcome(courseId:number,questionId:number,outcomeId:number) {
  positive(courseId,'course'); positive(questionId,'question'); positive(outcomeId,'outcome');
  // The faculty-tagged question must belong to an existing quiz from THIS course.
  // Check course, outcome and question in the same statement to prevent cross-course tags.
  const {rows} = await query(
    `INSERT INTO practice_question_outcomes(question_id,outcome_id)
     SELECT q.id,o.id FROM practice_questions q
     JOIN practice_quizzes z ON z.id=q.quiz_id AND z.course_id=$1
     JOIN course_learning_outcomes o ON o.course_id=z.course_id AND o.id=$3
     WHERE q.id=$2
     ON CONFLICT(question_id) DO UPDATE SET outcome_id=EXCLUDED.outcome_id,mapped_at=NOW()
     RETURNING question_id`,[courseId,questionId,outcomeId]);
  if(!rows.length)throw new AppError('Question or CLO not found in the selected course',400);
  return true;
}
export async function unmapQuestionOutcome(courseId:number,questionId:number) {
  positive(courseId,'course');positive(questionId,'question');
  await query(`DELETE FROM practice_question_outcomes m USING practice_questions q,practice_quizzes z
    WHERE m.question_id=q.id AND q.quiz_id=z.id AND z.course_id=$1 AND m.question_id=$2`,
    [courseId,questionId]);
  return true;
}
export async function outcomeQuestions(courseId:number,limit=50) {
  positive(courseId,'course');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AppError('Limit must be 1–100',400);
  const {rows}=await query<any>(
    `SELECT q.id,q.lecture_id,l.title AS lecture_title,q.question,m.outcome_id
      FROM practice_questions q JOIN practice_quizzes z ON z.id=q.quiz_id
      JOIN lectures l ON l.id=q.lecture_id
      LEFT JOIN practice_question_outcomes m ON m.question_id=q.id
      WHERE z.course_id=$1 ORDER BY q.id DESC LIMIT $2`,[courseId,limit]);
  return rows.map(r=>({
    questionId:Number(r.id),lectureId:Number(r.lecture_id),lectureTitle:r.lecture_title,
    question:r.question,outcomeId:r.outcome_id===null?null:Number(r.outcome_id)
  }));
}
const status = (attempted:number,correct:number):string => {
  if(attempted===0)return 'NOT_ASSESSED';
  if(attempted<3)return 'INSUFFICIENT_EVIDENCE';
  const accuracy=correct/attempted;
  return accuracy>=0.8?'STRONG':accuracy>=0.6?'DEVELOPING':'NEEDS_REVISION';
};
export async function studentOutcomeProgress(studentId:string,courseId:number){
  positive(courseId,'course');
  const {rows}=await query<any>(
    `SELECT o.id,o.code,o.description,
      COUNT(a.question_id)::int AS attempted,
      COUNT(a.question_id) FILTER(WHERE a.is_correct)::int AS correct
     FROM course_learning_outcomes o
     LEFT JOIN practice_question_outcomes m ON m.outcome_id=o.id
     LEFT JOIN practice_questions q ON q.id=m.question_id
     LEFT JOIN practice_quizzes z ON z.id=q.quiz_id AND z.student_id=$2
        AND z.course_id=$1 AND z.status='COMPLETED'
     LEFT JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
     WHERE o.course_id=$1 GROUP BY o.id ORDER BY o.code`,[courseId,studentId]);
  return rows.map(r=>{
    const attempted=Number(r.attempted),correct=Number(r.correct);
    return {outcomeId:Number(r.id),code:r.code,description:r.description,attempted,correct,
      percent:attempted?Math.round(correct*100/attempted):null,status:status(attempted,correct)};
  });
}
export async function facultyOutcomeSummary(courseId:number){
  positive(courseId,'course');
  const {rows}=await query<any>(
    `SELECT o.id,o.code,o.description,
      COUNT(a.question_id)::int AS attempted,
      COUNT(a.question_id) FILTER(WHERE a.is_correct)::int AS correct,
      COUNT(DISTINCT z.student_id) FILTER(WHERE a.question_id IS NOT NULL)::int AS students
     FROM course_learning_outcomes o
     LEFT JOIN practice_question_outcomes m ON m.outcome_id=o.id
     LEFT JOIN practice_questions q ON q.id=m.question_id
     LEFT JOIN practice_quizzes z ON z.id=q.quiz_id AND z.course_id=$1 AND z.status='COMPLETED'
     LEFT JOIN practice_answers a ON a.quiz_id=z.id AND a.question_id=q.id
     WHERE o.course_id=$1 GROUP BY o.id ORDER BY o.code`,[courseId]);
  return rows.map(r=>{const attempted=Number(r.attempted),correct=Number(r.correct);return {
    outcomeId:Number(r.id),code:r.code,description:r.description,attempted,correct,
    students:Number(r.students),percent:attempted?Math.round(correct*100/attempted):null
  };});
}
