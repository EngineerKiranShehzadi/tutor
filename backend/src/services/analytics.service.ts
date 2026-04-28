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
  const { rows } = await query<{ lecture_id: number; title: string; count: string }>(
    `SELECT sq.lecture_id, l.title, COUNT(sq.id) AS count
     FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     GROUP BY sq.lecture_id, l.title
     ORDER BY count DESC`
  );
  return rows.map(r => ({
    lectureId:    r.lecture_id,
    lectureTitle: r.title,
    count:        parseInt(r.count),
  }));
};

export const getRecentQuestions = async (limit = 20) => {
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
  const { rows } = await query<{ id: number; title: string; status: string }>(
    `SELECT id, title, status FROM lectures ORDER BY created_at DESC`
  );
  return rows;
};

export const getRegisteredStudents = async () => {
  const { rows } = await query<{ id: string; name: string; email: string; created_at: Date }>(
    `SELECT id, name, email, created_at FROM users WHERE role = 'STUDENT' ORDER BY created_at DESC`
  );
  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    email:     r.email,
    createdAt: r.created_at.toISOString(),
  }));
};
