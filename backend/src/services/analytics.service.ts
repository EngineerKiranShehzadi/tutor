import { query } from '../config/database';
import { logger } from '../utils/logger';

export const getAnalyticsSummary = async () => {
  const [students, lectures, questions, readyAgents] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE role = 'STUDENT'`),
    query<{ count: string }>(`SELECT COUNT(*) FROM lectures`),
    query<{ count: string }>(`SELECT COUNT(*) FROM student_questions`),
    query<{ count: string }>(`SELECT COUNT(*) FROM lectures WHERE status = 'READY'`),
  ]);

  const summary = {
    totalStudents:  parseInt(students.rows[0].count),
    totalLectures:  parseInt(lectures.rows[0].count),
    totalQuestions: parseInt(questions.rows[0].count),
    readyAgents:    parseInt(readyAgents.rows[0].count),
  };

  logger.info(`[ANALYTICS] Summary: ${JSON.stringify(summary)}`);
  return summary;
};

export const getQuestionsPerLecture = async () => {
  logger.info('[ANALYTICS] getQuestionsPerLecture: fetching question counts per lecture');
  const { rows } = await query<{ lecture_id: number; title: string; count: string }>(
    `SELECT sq.lecture_id, l.title, COUNT(sq.id) AS count
     FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     GROUP BY sq.lecture_id, l.title
     ORDER BY count DESC`
  );
  logger.info(`[ANALYTICS] questionsPerLecture: ${rows.length} lecture(s) with questions`);
  return rows.map(r => ({
    lectureId:    r.lecture_id,
    lectureTitle: r.title,
    count:        parseInt(r.count),
  }));
};

export const getRecentQuestions = async (limit = 20) => {
  logger.info(`[ANALYTICS] getRecentQuestions: fetching last ${limit} questions`);
  const { rows } = await query<{
    id: number; name: string; email: string; title: string; question: string; created_at: Date;
  }>(
    `SELECT sq.id, u.name, u.email, l.title, sq.question, sq.created_at
     FROM student_questions sq
     JOIN users u ON u.id = sq.student_id
     JOIN lectures l ON l.id = sq.lecture_id
     ORDER BY sq.created_at DESC
     LIMIT $1`,
    [limit]
  );
  logger.info(`[ANALYTICS] recentQuestions: returned ${rows.length} question(s)`);
  return rows.map(r => ({
    id:           r.id,
    studentName:  r.name,
    studentEmail: r.email,
    lectureTitle: r.title,
    question:     r.question,
    createdAt:    r.created_at.toISOString(),
  }));
};

export const getLectureStatusList = async () => {
  logger.info('[ANALYTICS] getLectureStatusList: fetching all lecture statuses');
  const { rows } = await query<{ id: number; title: string; status: string }>(
    `SELECT id, title, status FROM lectures ORDER BY created_at DESC`
  );
  logger.info(`[ANALYTICS] lectureStatusList: ${rows.length} lecture(s)`);
  return rows;
};

export const getRegisteredStudents = async () => {
  logger.info('[ANALYTICS] getRegisteredStudents: fetching all registered students');
  const { rows } = await query<{ id: string; name: string; email: string; created_at: Date }>(
    `SELECT id, name, email, created_at FROM users WHERE role = 'STUDENT' ORDER BY created_at DESC`
  );
  logger.info(`[ANALYTICS] registeredStudents: ${rows.length} student(s)`);
  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    email:     r.email,
    createdAt: r.created_at.toISOString(),
  }));
};
