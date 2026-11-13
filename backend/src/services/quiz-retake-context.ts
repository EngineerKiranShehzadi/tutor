import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import type { PreviousQuestion } from './quiz-novelty';
export interface RetakeContext { courseId: number; lectureIds: number[]; previous: PreviousQuestion[] }
// A single ownership-scoped read. No correct answers, scores or source text are
// accepted from the client, and the old attempt is never updated.
export const RETAKE_CONTEXT_SQL = `
SELECT q.course_id, q.lecture_ids, q.status, q.question_count,
  coalesce(jsonb_agg(jsonb_build_object('lectureId', p.lecture_id,
    'question', p.question, 'sourceId', p.source_chunk_id) ORDER BY p.position)
    FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS questions
FROM practice_quizzes q LEFT JOIN practice_questions p ON p.quiz_id = q.id
WHERE q.id = $1 AND q.student_id = $2
GROUP BY q.id`;
export async function loadRetakeContext(studentId: string, previousQuizId: number): Promise<RetakeContext> {
  if (!Number.isSafeInteger(previousQuizId) || previousQuizId <= 0) throw new AppError('Invalid quiz.', 400);
  const { rows } = await query<{ course_id: number; lecture_ids: number[]; status: string; question_count: number; questions: PreviousQuestion[] }>(RETAKE_CONTEXT_SQL, [previousQuizId, studentId]);
  const old = rows[0];
  if (!old) throw new AppError('Quiz not found.', 404);
  if (old.status !== 'COMPLETED') throw new AppError('Submit this quiz before requesting a retake.', 409);
  if (!Array.isArray(old.lecture_ids) || !old.lecture_ids.length || old.lecture_ids.length > 50 ||
      old.lecture_ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(old.lecture_ids).size !== old.lecture_ids.length ||
      !Array.isArray(old.questions) || old.questions.length !== old.question_count || old.questions.length > 50 ||
      !old.questions.length || old.questions.some(q => !old.lecture_ids.includes(q.lectureId) || typeof q.question !== 'string' || q.question.length > 1000) ||
      old.lecture_ids.some(id => !old.questions.some(q => q.lectureId === id))) {
    throw new AppError('This saved quiz has incomplete lecture or question information. Start a new practice quiz.', 409);
  }
  return { courseId: old.course_id, lectureIds: [...old.lecture_ids], previous: old.questions };
}
