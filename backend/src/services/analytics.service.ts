import { query } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { getAllLectureReadiness } from './dataset-version.service';
import { clampInt, likePattern, pageArgs } from '../utils/paging';

export const getAnalyticsSummary = async () => {
  const [students, lectures, questions, readyAgents] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE role = 'STUDENT'`),
    query<{ count: string }>(`SELECT COUNT(*) FROM lectures`),
    query<{ count: string }>(`SELECT COUNT(*) FROM student_questions`),
    // Operationally ready agent = exactly the lectures chat will serve:
    // dataset processed (status READY), an active agent profile AND a fully
    // embedded active dataset version (getLectureReadiness). EXISTS is
    // a semi-join, so a lecture can never be counted twice. lecture.status
    // itself is unchanged and keeps meaning "dataset processed".
    // Ids only; the dataset-readiness half of the definition is applied below
    // with the same getAllLectureReadiness() the agent list uses.
    query<{ id: number }>(
      `SELECT l.id FROM lectures l
       WHERE l.status = 'READY'
         AND EXISTS (
           SELECT 1 FROM lecture_agent_profiles p
           WHERE p.lecture_id = l.id AND p.is_active = TRUE
         )`
    ),
  ]);

  const readiness = await getAllLectureReadiness();
  const summary = {
    totalStudents:  parseInt(students.rows[0].count),
    totalLectures:  parseInt(lectures.rows[0].count),
    totalQuestions: parseInt(questions.rows[0].count),
    readyAgents:    readyAgents.rows.filter(r => readiness.get(r.id)?.ready).length,
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

// Student questions include names and e-mails, so they are only ever served a
// page at a time (A11): the list returns at most RECENT_QUESTIONS_MAX, a page at
// most RECENT_QUESTIONS_PAGE_MAX rows.
export const RECENT_QUESTIONS_MAX = 100;
export const RECENT_QUESTIONS_PAGE_MAX = 200;

export interface RecentQuestionsFilter { limit?: number | null; offset?: number | null; search?: string | null; lectureId?: number | null }

export const getRecentQuestionsPage = async (f: RecentQuestionsFilter) => {
  const limit = clampInt(f.limit, 20, 1, RECENT_QUESTIONS_PAGE_MAX);
  const offset = clampInt(f.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const search = (f.search ?? '').trim().slice(0, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    // LIKE wildcards in the search text are matched literally.
    params.push(likePattern(search));
    where.push(`(sq.question ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
  }
  if (typeof f.lectureId === 'number') {
    params.push(f.lectureId);
    where.push(`sq.lecture_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM student_questions sq
     JOIN users u ON u.id = sq.student_id
     JOIN lectures l ON l.id = sq.lecture_id`;

  const [{ rows }, { rows: cnt }] = await Promise.all([
    query<{ id: number; name: string; email: string; lecture_id: number; title: string; question: string; created_at: Date }>(
      `SELECT sq.id, u.name, u.email, sq.lecture_id, l.title, sq.question, sq.created_at
       ${from} ${whereSql}
       ORDER BY sq.created_at DESC, sq.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params),
  ]);
  const total = Number(cnt[0]?.n ?? 0);
  logger.info(`[ANALYTICS] recentQuestionsPage: ${rows.length} of ${total} (offset ${offset}${search ? ', search' : ''}${f.lectureId != null ? `, lecture #${f.lectureId}` : ''})`);
  return {
    items: rows.map(r => ({
      id:           r.id,
      studentName:  r.name,
      studentEmail: r.email,
      lectureId:    r.lecture_id,
      lectureTitle: r.title,
      question:     r.question,
      createdAt:    r.created_at.toISOString(),
    })),
    total,
    hasMore: offset + rows.length < total,
  };
};

export const getRecentQuestions = async (limit?: number | null) =>
  (await getRecentQuestionsPage({ limit: clampInt(limit, 10, 1, RECENT_QUESTIONS_MAX), offset: 0 })).items;

export const getLectureStatusList = async () => {
  logger.info('[ANALYTICS] getLectureStatusList: fetching all lecture statuses');
  const { rows } = await query<{ id: number; title: string; status: string }>(
    `SELECT id, title, status FROM lectures ORDER BY created_at DESC`
  );
  logger.info(`[ANALYTICS] lectureStatusList: ${rows.length} lecture(s)`);
  return rows;
};

// One page of the active version's chunks (full answers) for a lecture, with
// server-side search over question, answer and topic.
export const getLectureChunks = async (
  lectureId: number,
  f: { limit?: number | null; offset?: number | null; search?: string | null } = {}
) => {
  const { limit, offset, search } = pageArgs(f);
  const params: unknown[] = [lectureId];
  let searchSql = '';
  if (search) {
    params.push(likePattern(search));
    searchSql = `AND (question ILIKE $2 OR answer ILIKE $2 OR topic ILIKE $2)`;
  }
  const where = `WHERE lecture_id = $1
       AND id IN (SELECT chunk_id FROM dataset_version_chunks
                  WHERE version_id = (SELECT active_version_id FROM lectures WHERE id = $1))
       ${searchSql}`;
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query<{
      id: number; topic: string | null; question: string; answer: string;
      start_time: string | null; end_time: string | null; keywords: string | null;
    }>(
      `SELECT id, topic, question, answer, start_time, end_time, keywords
       FROM lecture_qna_chunks
       ${where}
       ORDER BY id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n FROM lecture_qna_chunks ${where}`, params),
  ]);
  const total = Number(cnt[0]?.n ?? 0);
  logger.info(`[ANALYTICS] lectureChunks: ${rows.length} of ${total} chunk(s) for lecture #${lectureId} (offset ${offset}${search ? ', search' : ''})`);
  return {
    items: rows.map(r => ({
      id:        r.id,
      topic:     r.topic ?? null,
      question:  r.question,
      answer:    r.answer,
      startTime: r.start_time ?? null,
      endTime:   r.end_time ?? null,
      keywords:  r.keywords ?? null,
    })),
    total,
    hasMore: offset + rows.length < total,
  };
};

export const getLectureAgentDetails = async () => {
  logger.info('[ANALYTICS] getLectureAgentDetails: fetching all agents with chunk counts');
  const { rows } = await query<{
    id: number; title: string; status: string; chunk_count: string; created_at: Date; updated_at: Date;
    profile_is_active: boolean | null;
  }>(
    `SELECT l.id, l.title, l.status,
            COUNT(c.id) AS chunk_count,
            l.created_at, l.updated_at,
            (SELECT p.is_active FROM lecture_agent_profiles p WHERE p.lecture_id = l.id) AS profile_is_active
     FROM lectures l
     LEFT JOIN dataset_version_chunks d ON d.version_id = l.active_version_id
     LEFT JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     GROUP BY l.id ORDER BY l.created_at DESC`
  );
  const readiness = await getAllLectureReadiness();
  return rows.map(r => ({
    id:         r.id,
    title:      r.title,
    status:     r.status,
    chunkCount: parseInt(r.chunk_count),
    createdAt:  r.created_at.toISOString(),
    updatedAt:  r.updated_at.toISOString(),
    // MISSING (no profile row) | INACTIVE | ACTIVE — lecture_id is the profile's
    // primary key, so the scalar subquery above yields at most one row.
    agentProfileStatus: r.profile_is_active === null ? 'MISSING' : r.profile_is_active ? 'ACTIVE' : 'INACTIVE',
    // Same condition as the readyAgents metric and as askLectureAgent's gate:
    // dataset processed AND an active agent profile.
    // plus a fully embedded active dataset version (getLectureReadiness).
    chatReady: r.status === 'READY' && r.profile_is_active === true && (readiness.get(r.id)?.ready ?? false),
    // Why the dataset is not ready (null when it is) — shown for lectures that
    // are READY by status but cannot serve chat.
    // A ready dataset behind a non-READY status (should not happen; repaired
    // at startup) is reported too, so chat being off is never unexplained.
    notReadyReason: readiness.get(r.id)?.ready
      ? (r.status === 'READY' ? null : `STATUS_NOT_READY: the dataset is live but the lecture status is ${r.status}`)
      : (readiness.get(r.id)?.reason ?? 'LECTURE_NOT_FOUND'),
  }));
};

// One page of students (names and e-mails — never the whole table), with
// server-side search over name/e-mail and an ACTIVE (asked at least one
// question) / INACTIVE filter. The summary counts cover every student.
export const getRegisteredStudents = async (
  f: { limit?: number | null; offset?: number | null; search?: string | null; status?: string | null } = {}
) => {
  const { limit, offset, search } = pageArgs(f);
  const where = [`u.role = 'STUDENT'`];
  const params: unknown[] = [];
  if (search) {
    params.push(likePattern(search));
    where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  const asked = `EXISTS (SELECT 1 FROM student_questions sq WHERE sq.student_id = u.id)`;
  if (f.status === 'ACTIVE') where.push(asked);
  if (f.status === 'INACTIVE') where.push(`NOT ${asked}`);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [{ rows }, { rows: cnt }, { rows: summary }] = await Promise.all([
    query<{ id: string; name: string; email: string; created_at: Date; question_count: string }>(
      `SELECT u.id, u.name, u.email, u.created_at,
              (SELECT COUNT(*) FROM student_questions sq WHERE sq.student_id = u.id)::int AS question_count
       FROM users u ${whereSql}
       ORDER BY u.created_at DESC, u.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, params),
    query<{ total: string; active: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ${asked}) AS active FROM users u WHERE u.role = 'STUDENT'`
    ),
  ]);
  const total = Number(cnt[0]?.n ?? 0);
  const totalStudents = Number(summary[0]?.total ?? 0);
  const activeCount = Number(summary[0]?.active ?? 0);
  logger.info(`[ANALYTICS] registeredStudents: ${rows.length} of ${total} (offset ${offset}${search ? ', search' : ''}${f.status ? `, ${f.status}` : ''})`);
  return {
    items: rows.map(r => {
      const qCount = Number(r.question_count);
      return {
        id:            r.id,
        name:          r.name,
        email:         r.email,
        createdAt:     r.created_at.toISOString(),
        questionCount: qCount,
        status:        qCount > 0 ? 'ACTIVE' : 'INACTIVE',
      };
    }),
    total,
    hasMore: offset + rows.length < total,
    totalStudents,
    activeCount,
    inactiveCount: totalStudents - activeCount,
  };
};

// A student's profile plus ONE page of their questions (newest first). The
// totals, first/last activity and per-lecture breakdown come from aggregates,
// so they stay exact whatever page is shown.
export const getStudentJourney = async (
  studentId: string,
  f: { limit?: number | null; offset?: number | null } = {}
) => {
  logger.info(`[ANALYTICS] getStudentJourney: ${studentId}`);
  const { limit, offset } = pageArgs(f);

  const [userRes, questionsRes, totalsRes, byLectureRes] = await Promise.all([
    query<{ id: string; name: string; email: string; created_at: Date }>(
      `SELECT id, name, email, created_at FROM users WHERE id = $1 AND role = 'STUDENT'`,
      [studentId]
    ),
    query<{ id: number; question: string; lecture_title: string; lecture_id: number; created_at: Date }>(
      `SELECT sq.id, sq.question, l.title AS lecture_title, l.id AS lecture_id, sq.created_at
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       ORDER BY sq.created_at DESC, sq.id DESC
       LIMIT $2 OFFSET $3`,
      [studentId, limit, offset]
    ),
    query<{ n: string; first: Date | null; last: Date | null }>(
      `SELECT COUNT(*) AS n, MIN(sq.created_at) AS first, MAX(sq.created_at) AS last
       FROM student_questions sq JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1`,
      [studentId]
    ),
    query<{ lecture_id: number; title: string; n: string; first: Date; last: Date }>(
      `SELECT l.id AS lecture_id, l.title, COUNT(*) AS n, MIN(sq.created_at) AS first, MAX(sq.created_at) AS last
       FROM student_questions sq JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       GROUP BY l.id, l.title
       ORDER BY MAX(sq.created_at) DESC`,
      [studentId]
    ),
  ]);

  const user = userRes.rows[0];
  // An expected outcome, not a crash: a plain Error was masked as "Internal
  // server error" and logged as one.
  if (!user) throw new AppError('Student not found', 404);

  const questions = questionsRes.rows.map(r => ({
    id:           r.id,
    question:     r.question,
    lectureTitle: r.lecture_title,
    lectureId:    r.lecture_id,
    createdAt:    r.created_at.toISOString(),
  }));
  const byLecture = byLectureRes.rows.map(r => ({
    lectureId:     r.lecture_id,
    lectureTitle:  r.title,
    questionCount: Number(r.n),
    firstAsked:    r.first.toISOString(),
    lastAsked:     r.last.toISOString(),
  }));

  const qCount = Number(totalsRes.rows[0]?.n ?? 0);
  return {
    studentId:       user.id,
    studentName:     user.name,
    studentEmail:    user.email,
    status:          qCount > 0 ? 'ACTIVE' : 'INACTIVE',
    // Total questions (all pages); `questions` holds only the requested page.
    questionCount:   qCount,
    lecturesEngaged: byLecture.length,
    joinedAt:        user.created_at.toISOString(),
    firstActivity:   totalsRes.rows[0]?.first?.toISOString() ?? null,
    lastActivity:    totalsRes.rows[0]?.last?.toISOString() ?? null,
    questions,
    hasMoreQuestions: offset + questions.length < qCount,
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

// Content Gaps is bounded: it reads at most the newest CONTENT_GAPS_MAX_QUESTIONS
// questions from the last CONTENT_GAPS_WINDOW_DAYS days and at most
// CONTENT_GAPS_MAX_CHUNKS chunks, and tokenises them one by one — it used to load
// every question ever asked plus every active chunk and tokenise one giant joined
// string, stalling the shared event loop (and every student's chat) as both grew.
export const CONTENT_GAPS_WINDOW_DAYS = 90;
export const CONTENT_GAPS_MAX_QUESTIONS = 20_000;
export const CONTENT_GAPS_MAX_CHUNKS = 20_000;

export const getContentGaps = async () => {
  logger.info('[ANALYTICS] getContentGaps: comparing student questions vs AI training data');

  // Exact per-lecture counts for the window — the headline number never
  // depends on the sample below. Only lectures with a trained AI agent (READY).
  const { rows: askedRows } = await query<{ lecture_id: number; lecture_title: string; asked: string }>(
    `SELECT sq.lecture_id, l.title AS lecture_title, COUNT(*) AS asked
     FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     WHERE l.status = 'READY'
       AND sq.created_at >= NOW() - make_interval(days => $1)
     GROUP BY sq.lecture_id, l.title`,
    [CONTENT_GAPS_WINDOW_DAYS]
  );
  if (askedRows.length === 0) return [];
  const totalInWindow = askedRows.reduce((n, r) => n + Number(r.asked), 0);

  const { rows: studentQs } = await query<{ lecture_id: number; question: string }>(
    `SELECT sq.lecture_id, sq.question
     FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     WHERE l.status = 'READY'
       AND sq.created_at >= NOW() - make_interval(days => $1)
     ORDER BY sq.created_at DESC
     LIMIT $2`,
    [CONTENT_GAPS_WINDOW_DAYS, CONTENT_GAPS_MAX_QUESTIONS]
  );
  const sampled = totalInWindow > studentQs.length;

  const lectureIds = askedRows.map(r => r.lecture_id);

  // Get training data (QNA chunks) for those lectures
  const { rows: chunks } = await query<{
    lecture_id: number; topic: string | null; question: string; keywords: string | null;
  }>(
    `SELECT lecture_id, topic, question, keywords
     FROM lecture_qna_chunks c
     WHERE lecture_id = ANY($1::int[])
       AND c.id IN (SELECT d.chunk_id FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE l.id = c.lecture_id)
     LIMIT $2`,
    [lectureIds, CONTENT_GAPS_MAX_CHUNKS]
  );

  // Get chunk counts per lecture
  const { rows: countRows } = await query<{ lecture_id: number; count: string }>(
    `SELECT lecture_id, COUNT(*) AS count
     FROM lecture_qna_chunks c
     WHERE lecture_id = ANY($1::int[])
       AND c.id IN (SELECT d.chunk_id FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE l.id = c.lecture_id)
     GROUP BY lecture_id`,
    [lectureIds]
  );
  const chunkCountMap = new Map(countRows.map(r => [r.lecture_id, Number(r.count)]));

  // Per-lecture sampled questions
  const lectureStudentQs = new Map<number, string[]>();
  for (const q of studentQs) {
    if (!lectureStudentQs.has(q.lecture_id)) lectureStudentQs.set(q.lecture_id, []);
    lectureStudentQs.get(q.lecture_id)!.push(q.question);
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

  for (const { lecture_id: lectureId, lecture_title: title, asked } of askedRows) {
    const questions = lectureStudentQs.get(lectureId) ?? [];
    const chunkVocab = chunkVocabMap.get(lectureId) ?? new Set<string>();
    const chunkCount = chunkCountMap.get(lectureId) ?? 0;

    // Each question is tokenised once: its keywords go into the lecture-wide
    // set, and it counts as "answered from lecture" if ANY of them appears in
    // the chunk vocabulary (otherwise it was unanswerable from lecture content).
    const studentKeywords = new Set<string>();
    let answeredFromLecture = 0;
    let notInLecture = 0;
    for (const q of questions) {
      const qKeywords = tokenize(q);
      let hasMatch = false;
      for (const kw of qKeywords) {
        studentKeywords.add(kw);
        if (chunkVocab.has(kw)) hasMatch = true;
      }
      if (hasMatch) answeredFromLecture++;
      else notInLecture++;
    }

    // Partition: covered vs gap
    const covered: string[] = [];
    const gaps: string[] = [];
    for (const kw of studentKeywords) {
      (chunkVocab.has(kw) ? covered : gaps).push(kw);
    }

    const total = covered.length + gaps.length;
    const coverageScore = total > 0 ? Math.round((covered.length / total) * 100) : 100;
    const status = coverageScore >= 70 ? 'GOOD' : coverageScore >= 40 ? 'MODERATE' : 'POOR';

    results.push({
      lectureId,
      lectureTitle:        title,
      questionsAsked:      Number(asked),
      chunkCount,
      coverageScore,
      gapTopics:           gaps.slice(0, 20),
      coveredTopics:       covered.slice(0, 20),
      status,
      answeredFromLecture,
      notInLecture,
      // True when the window held more questions than were analysed (the
      // newest CONTENT_GAPS_MAX_QUESTIONS were used).
      sampled,
      windowDays:          CONTENT_GAPS_WINDOW_DAYS,
    });
  }

  // Sort by worst coverage first so admin sees biggest gaps at top
  return results.sort((a, b) => a.coverageScore - b.coverageScore);
};

// Rankings below order by the numeric aggregate: the ::text aliases (kept for
// the row types) sorted alphabetically, so "9" ranked above "10".
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
       GROUP BY l.title ORDER BY COUNT(sq.id) DESC LIMIT 1`, [studentId]
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
       GROUP BY l.id, l.title ORDER BY COUNT(sq.id) DESC LIMIT 6`, [studentId]
    ),
    query<{ hour: string; count: string }>(
      `SELECT EXTRACT(HOUR FROM created_at)::text AS hour, COUNT(*)::text AS count
       FROM student_questions WHERE student_id = $1
       GROUP BY hour ORDER BY COUNT(*) DESC LIMIT 1`, [studentId]
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
