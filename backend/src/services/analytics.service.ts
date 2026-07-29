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

export const getRecentQuestions = async (limit = 10000) => {
  logger.info(`[ANALYTICS] getRecentQuestions: fetching up to ${limit} questions`);
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

export const getLectureChunks = async (lectureId: number) => {
  logger.info(`[ANALYTICS] getLectureChunks: lecture #${lectureId}`);
  const { rows } = await query<{
    id: number; topic: string | null; question: string; answer: string;
    start_time: string | null; end_time: string | null; keywords: string | null;
  }>(
    `SELECT id, topic, question, answer, start_time, end_time, keywords
     FROM lecture_qna_chunks WHERE lecture_id = $1 ORDER BY id`,
    [lectureId]
  );
  logger.info(`[ANALYTICS] lectureChunks: ${rows.length} chunk(s) for lecture #${lectureId}`);
  return rows.map(r => ({
    id:        r.id,
    topic:     r.topic ?? null,
    question:  r.question,
    answer:    r.answer,
    startTime: r.start_time ?? null,
    endTime:   r.end_time ?? null,
    keywords:  r.keywords ?? null,
  }));
};

export const getLectureAgentDetails = async () => {
  logger.info('[ANALYTICS] getLectureAgentDetails: fetching all agents with chunk counts');
  const { rows } = await query<{
    id: number; title: string; status: string; chunk_count: string; created_at: Date; updated_at: Date;
  }>(
    `SELECT l.id, l.title, l.status,
            COUNT(c.id) AS chunk_count,
            l.created_at, l.updated_at
     FROM lectures l
     LEFT JOIN lecture_qna_chunks c ON c.lecture_id = l.id
     GROUP BY l.id ORDER BY l.created_at DESC`
  );
  return rows.map(r => ({
    id:         r.id,
    title:      r.title,
    status:     r.status,
    chunkCount: parseInt(r.chunk_count),
    createdAt:  r.created_at.toISOString(),
    updatedAt:  r.updated_at.toISOString(),
  }));
};

export const getRegisteredStudents = async () => {
  logger.info('[ANALYTICS] getRegisteredStudents: fetching all registered students');
  const { rows } = await query<{
    id: string; name: string; email: string; created_at: Date; question_count: string;
  }>(
    `SELECT u.id, u.name, u.email, u.created_at,
            COUNT(sq.id)::int AS question_count
     FROM users u
     LEFT JOIN student_questions sq ON sq.student_id = u.id
     WHERE u.role = 'STUDENT'
     GROUP BY u.id, u.name, u.email, u.created_at
     ORDER BY u.created_at DESC`
  );
  logger.info(`[ANALYTICS] registeredStudents: ${rows.length} student(s)`);
  return rows.map(r => {
    const qCount = Number(r.question_count);
    return {
      id:            r.id,
      name:          r.name,
      email:         r.email,
      createdAt:     r.created_at.toISOString(),
      questionCount: qCount,
      status:        qCount > 0 ? 'ACTIVE' : 'INACTIVE',
    };
  });
};

export const getStudentJourney = async (studentId: string) => {
  logger.info(`[ANALYTICS] getStudentJourney: ${studentId}`);

  const [userRes, questionsRes] = await Promise.all([
    query<{ id: string; name: string; email: string; created_at: Date }>(
      `SELECT id, name, email, created_at FROM users WHERE id = $1 AND role = 'STUDENT'`,
      [studentId]
    ),
    query<{ id: number; question: string; lecture_title: string; lecture_id: number; created_at: Date }>(
      `SELECT sq.id, sq.question, l.title AS lecture_title, l.id AS lecture_id, sq.created_at
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       ORDER BY sq.created_at DESC`,
      [studentId]
    ),
  ]);

  const user = userRes.rows[0];
  if (!user) throw new Error('Student not found');

  const questions = questionsRes.rows.map(r => ({
    id:           r.id,
    question:     r.question,
    lectureTitle: r.lecture_title,
    lectureId:    r.lecture_id,
    createdAt:    r.created_at.toISOString(),
  }));

  // Group by lecture
  const lectureMap = new Map<number, { title: string; questions: typeof questions }>();
  for (const q of questions) {
    if (!lectureMap.has(q.lectureId)) lectureMap.set(q.lectureId, { title: q.lectureTitle, questions: [] });
    lectureMap.get(q.lectureId)!.questions.push(q);
  }

  const byLecture = Array.from(lectureMap.entries()).map(([lectureId, v]) => {
    const sorted = v.questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      lectureId,
      lectureTitle:  v.title,
      questionCount: v.questions.length,
      firstAsked:    sorted[0].createdAt,
      lastAsked:     sorted[sorted.length - 1].createdAt,
    };
  });

  const qCount = questions.length;
  return {
    studentId:       user.id,
    studentName:     user.name,
    studentEmail:    user.email,
    status:          qCount > 0 ? 'ACTIVE' : 'INACTIVE',
    questionCount:   qCount,
    lecturesEngaged: lectureMap.size,
    joinedAt:        user.created_at.toISOString(),
    firstActivity:   questions.length ? questions[questions.length - 1].createdAt : null,
    lastActivity:    questions.length ? questions[0].createdAt : null,
    questions,
    byLecture,
  };
};

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','what','how','why','when','where','which',
  'can','do','does','did','in','on','at','for','of','to','and','or','but','not',
  'with','that','this','it','its','be','has','have','had','will','would','could',
  'should','i','you','we','they','he','she','my','your','their','our','me','us',
  'him','her','if','so','than','then','there','here','from','by','about','as',
  'into','through','during','before','after','above','below','between','each',
  'few','more','most','other','some','such','no','nor','only','same','too','very',
  'just','because','while','although','though','since','until','unless','however',
  'also','both','either','neither','once','any','all','get','got','make','made',
  'use','used','using','want','need','give','take','tell','explain','define','mean',
  'means','difference','between','example','examples','work','works','like','know',
  'please','thanks','thank','hello','help','understand','understanding','concept',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w))
  );
}

export const getContentGaps = async () => {
  logger.info('[ANALYTICS] getContentGaps: comparing student questions vs AI training data');

  // Only analyse lectures that have a trained AI agent (READY status)
  const { rows: studentQs } = await query<{
    lecture_id: number; lecture_title: string; question: string;
  }>(
    `SELECT sq.lecture_id, l.title AS lecture_title, sq.question
     FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     WHERE l.status = 'READY'`
  );

  if (studentQs.length === 0) return [];

  const lectureIds = [...new Set(studentQs.map(q => q.lecture_id))];

  // Get training data (QNA chunks) for those lectures
  const { rows: chunks } = await query<{
    lecture_id: number; topic: string | null; question: string; keywords: string | null;
  }>(
    `SELECT lecture_id, topic, question, keywords
     FROM lecture_qna_chunks
     WHERE lecture_id = ANY($1::int[])`,
    [lectureIds]
  );

  // Get chunk counts per lecture
  const { rows: countRows } = await query<{ lecture_id: number; count: string }>(
    `SELECT lecture_id, COUNT(*) AS count
     FROM lecture_qna_chunks
     WHERE lecture_id = ANY($1::int[])
     GROUP BY lecture_id`,
    [lectureIds]
  );
  const chunkCountMap = new Map(countRows.map(r => [r.lecture_id, Number(r.count)]));

  // Build per-lecture maps
  const lectureStudentQs = new Map<number, { title: string; questions: string[] }>();
  for (const q of studentQs) {
    if (!lectureStudentQs.has(q.lecture_id))
      lectureStudentQs.set(q.lecture_id, { title: q.lecture_title, questions: [] });
    lectureStudentQs.get(q.lecture_id)!.questions.push(q.question);
  }

  // Build chunk vocabulary per lecture
  const chunkVocabMap = new Map<number, Set<string>>();
  for (const c of chunks) {
    if (!chunkVocabMap.has(c.lecture_id)) chunkVocabMap.set(c.lecture_id, new Set());
    const vocab = chunkVocabMap.get(c.lecture_id)!;
    // Add tokenized question words
    for (const w of tokenize(c.question)) vocab.add(w);
    // Add explicit keywords field (comma-separated)
    if (c.keywords) c.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean).forEach(k => vocab.add(k));
    // Add topic words
    if (c.topic) for (const w of tokenize(c.topic)) vocab.add(w);
  }

  const results = [];

  for (const [lectureId, { title, questions }] of lectureStudentQs.entries()) {
    const chunkVocab = chunkVocabMap.get(lectureId) ?? new Set<string>();
    const chunkCount = chunkCountMap.get(lectureId) ?? 0;

    // Extract all keywords from student questions for this lecture
    const studentKeywords = tokenize(questions.join(' '));

    // Partition: covered vs gap
    const covered: string[] = [];
    const gaps: string[] = [];
    for (const kw of studentKeywords) {
      (chunkVocab.has(kw) ? covered : gaps).push(kw);
    }

    const total = covered.length + gaps.length;
    const coverageScore = total > 0 ? Math.round((covered.length / total) * 100) : 100;
    const status = coverageScore >= 70 ? 'GOOD' : coverageScore >= 40 ? 'MODERATE' : 'POOR';

    // Per-question coverage: a question is "answered from lecture" if ANY of its keywords
    // appear in the chunk vocabulary, otherwise it was unanswerable from lecture content
    let answeredFromLecture = 0;
    let notInLecture = 0;
    for (const q of questions) {
      const qKeywords = tokenize(q);
      const hasMatch = [...qKeywords].some(kw => chunkVocab.has(kw));
      if (hasMatch) answeredFromLecture++;
      else notInLecture++;
    }

    results.push({
      lectureId,
      lectureTitle:        title,
      questionsAsked:      questions.length,
      chunkCount,
      coverageScore,
      gapTopics:           gaps.slice(0, 20),
      coveredTopics:       covered.slice(0, 20),
      status,
      answeredFromLecture,
      notInLecture,
    });
  }

  // Sort by worst coverage first so admin sees biggest gaps at top
  return results.sort((a, b) => a.coverageScore - b.coverageScore);
};

export const getMyStats = async (studentId: string) => {
  const [
    totalQs, totalSessions, lecturesEngaged, totalAvailableLectures,
    lastActiveRes, memberSinceRes, weekQs, lastWeekQs, topicRes,
    streakRes, dailyRes, lectureBreakdownRes, peakHourRes,
  ] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) FROM student_questions WHERE student_id = $1`, [studentId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) FROM chat_sessions WHERE student_id = $1`, [studentId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT lecture_id) FROM student_questions WHERE student_id = $1`, [studentId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) FROM lectures`
    ),
    query<{ last_active: Date | null }>(
      `SELECT GREATEST(
         (SELECT MAX(created_at) FROM student_questions WHERE student_id = $1),
         (SELECT MAX(created_at) FROM chat_history    WHERE student_id = $1)
       ) AS last_active`, [studentId]
    ),
    query<{ created_at: Date }>(
      `SELECT created_at FROM users WHERE id = $1`, [studentId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) FROM student_questions WHERE student_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`, [studentId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) FROM student_questions WHERE student_id = $1 AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'`, [studentId]
    ),
    query<{ title: string; cnt: string }>(
      `SELECT l.title, COUNT(sq.id)::text AS cnt
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       GROUP BY l.title ORDER BY cnt DESC LIMIT 1`, [studentId]
    ),
    query<{ day: string }>(
      `SELECT DISTINCT DATE(created_at) AS day
       FROM student_questions WHERE student_id = $1
       ORDER BY day DESC`, [studentId]
    ),
    query<{ day: string; count: string }>(
      `SELECT DATE(created_at)::text AS day, COUNT(*)::text AS count
       FROM student_questions
       WHERE student_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY day ORDER BY day ASC`, [studentId]
    ),
    query<{ lecture_id: number; title: string; cnt: string }>(
      `SELECT l.id AS lecture_id, l.title, COUNT(sq.id)::text AS cnt
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       GROUP BY l.id, l.title ORDER BY cnt DESC LIMIT 6`, [studentId]
    ),
    query<{ hour: string; count: string }>(
      `SELECT EXTRACT(HOUR FROM created_at)::text AS hour, COUNT(*)::text AS count
       FROM student_questions WHERE student_id = $1
       GROUP BY hour ORDER BY count DESC LIMIT 1`, [studentId]
    ),
  ]);

  // Compute streak — compare ISO date strings in UTC to avoid timezone mismatch
  // DB returns DATE(created_at) as "YYYY-MM-DD" in UTC; we compare using UTC dates too.
  const dayStrings = streakRes.rows.map(r => String(r.day).slice(0, 10));
  let streak = 0;
  const nowMs = Date.now();
  const MS_DAY = 86400000;
  for (let i = 0; i < dayStrings.length; i++) {
    const expectedStr = new Date(nowMs - i * MS_DAY).toISOString().split('T')[0];
    if (dayStrings[i] === expectedStr) streak++;
    else break;
  }

  // Build 7-day activity array using UTC dates (consistent with DB DATE() output)
  const dailyMap = new Map(dailyRes.rows.map(r => [r.day, parseInt(r.count, 10)]));
  const weeklyActivity = Array.from({ length: 7 }, (_, i) => {
    const dateStr = new Date(nowMs - (6 - i) * MS_DAY).toISOString().split('T')[0];
    const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC → stable weekday name
    return {
      day:   d.toLocaleDateString('en-US', { weekday: 'short' }),
      date:  dateStr,
      count: dailyMap.get(dateStr) ?? 0,
    };
  });

  const weekCount = parseInt(weekQs.rows[0]?.count ?? '0', 10);
  let activityBadge = 'Newcomer';
  if (weekCount >= 20) activityBadge = 'Power Learner';
  else if (weekCount >= 10) activityBadge = 'Active Learner';
  else if (weekCount >= 3)  activityBadge = 'Regular';
  else if (weekCount >= 1)  activityBadge = 'Getting Started';

  return {
    totalQuestions:          parseInt(totalQs.rows[0]?.count ?? '0', 10),
    totalSessions:           parseInt(totalSessions.rows[0]?.count ?? '0', 10),
    lecturesEngaged:         parseInt(lecturesEngaged.rows[0]?.count ?? '0', 10),
    totalAvailableLectures:  parseInt(totalAvailableLectures.rows[0]?.count ?? '0', 10),
    lastActive:              lastActiveRes.rows[0]?.last_active?.toISOString() ?? null,
    memberSince:             memberSinceRes.rows[0]?.created_at?.toISOString() ?? null,
    learningStreak:          streak,
    mostAskedTopic:          topicRes.rows[0]?.title ?? null,
    activityBadge,
    thisWeekQuestions:       weekCount,
    lastWeekQuestions:       parseInt(lastWeekQs.rows[0]?.count ?? '0', 10),
    weeklyActivity,
    lectureBreakdown:        lectureBreakdownRes.rows.map(r => ({
      lectureId:    r.lecture_id,
      lectureTitle: r.title,
      count:        parseInt(r.cnt, 10),
    })),
    peakHour: peakHourRes.rows[0] ? parseInt(peakHourRes.rows[0].hour, 10) : null,
  };
};
