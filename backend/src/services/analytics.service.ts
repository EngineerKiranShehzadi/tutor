import { query } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { getAllLectureReadiness } from './dataset-version.service';
import { clampInt, likePattern, pageArgs } from '../utils/paging';
import { env } from '../config/env';

/**
 * Turn a stored timestamp into a calendar day in the reporting timezone.
 *
 * Postgres keeps timestamps in UTC. `x AT TIME ZONE 'Asia/Karachi'` converts
 * one into the wall-clock time in that zone, so ::date then gives the day the
 * student experienced rather than the UTC day. The ::timestamptz cast makes
 * the expression behave the same whether the column is already timestamptz or
 * still a plain timestamp (which Postgres reads as UTC on this server).
 *
 * $tz is passed as a bind parameter, never interpolated.
 */
const localDay = (col: string, tzParam: string) => `((${col})::timestamptz AT TIME ZONE ${tzParam})::date`;

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

export interface RecentQuestionsFilter { limit?: number | null; offset?: number | null; search?: string | null; lectureId?: number | null; courseId?: number | null }

export const getRecentQuestionsPage = async (f: RecentQuestionsFilter) => {
  const limit = clampInt(f.limit, 20, 1, RECENT_QUESTIONS_PAGE_MAX);
  const offset = clampInt(f.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const search = (f.search ?? '').trim().slice(0, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    // LIKE wildcards in the search text are matched literally. The answer is
    // searched too now that it is returned: a page that shows the answer but
    // will not search it is the kind of half-feature people stop trusting.
    params.push(likePattern(search));
    where.push(`(ch.question ILIKE $${params.length} OR ch.answer ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
  }
  if (typeof f.lectureId === 'number') {
    params.push(f.lectureId);
    where.push(`ch.lecture_id = $${params.length}`);
  }
  // Course narrows to the lectures inside it. Both filters can apply at once;
  // picking a course then a lecture in it is simply a narrower query, and
  // picking a lecture outside it correctly returns nothing.
  if (typeof f.courseId === 'number') {
    params.push(f.courseId);
    where.push(`l.course_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /**
   * Reads chat_history, not student_questions.
   *
   * Both tables record the same event. student_questions holds the question
   * alone and was described as "admin analytics"; chat_history holds the
   * question, the answer, the chunks it was built from and the trace id. The
   * admin page was reading the thin copy, which is the only reason two
   * thousand answers were stored and never shown anywhere.
   *
   * The LEFT JOIN adds what happened: rag_request_log carries the outcome for
   * the same trace. It is a LEFT JOIN on purpose — chat_history.trace_id was
   * added later and is NULL on older rows, and a row with no outcome must
   * still appear with its question and answer rather than vanish.
   *
   * Trade-off, stated because it changes what this page means: a question
   * that errored before an answer existed has no chat_history row, so it is
   * not listed here. Those are in Observability, Errors.
   */
  const from = `FROM chat_history ch
     JOIN users u ON u.id = ch.student_id
     JOIN lectures l ON l.id = ch.lecture_id
     JOIN courses c ON c.id = l.course_id
     LEFT JOIN rag_request_log rl ON rl.trace_id = ch.trace_id`;

  const [{ rows }, { rows: cnt }] = await Promise.all([
    query<{
      id: number; name: string; email: string; lecture_id: number; title: string;
      course_id: number; course_title: string;
      question: string; answer: string; trace_id: string | null;
      response_status: string | null; not_found_reason: string | null; created_at: Date;
    }>(
      `SELECT ch.id, u.name, u.email, ch.lecture_id, l.title,
              c.id AS course_id, c.title AS course_title,
              ch.question, ch.answer,
              ch.trace_id, rl.response_status, rl.not_found_reason, ch.created_at
       ${from} ${whereSql}
       ORDER BY ch.created_at DESC, ch.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params),
  ]);
  const total = Number(cnt[0]?.n ?? 0);
  logger.info(`[ANALYTICS] recentQuestionsPage: ${rows.length} of ${total} (offset ${offset}${search ? ', search' : ''}${f.courseId != null ? `, course #${f.courseId}` : ''}${f.lectureId != null ? `, lecture #${f.lectureId}` : ''})`);
  return {
    items: rows.map(r => ({
      id:             r.id,
      studentName:    r.name,
      studentEmail:   r.email,
      lectureId:      r.lecture_id,
      lectureTitle:   r.title,
      courseId:       r.course_id,
      courseTitle:    r.course_title,
      question:       r.question,
      answer:         r.answer,
      traceId:        r.trace_id,
      outcome:        r.response_status,
      notFoundReason: r.not_found_reason,
      createdAt:      r.created_at.toISOString(),
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
  // One row per Q&A pair (the page labels them so): a long answer is stored
  // as several pieces, and every piece carries the full question and answer,
  // so only the first is listed and counted — as exportActiveDataset does.
  const where = `WHERE lecture_id = $1
       AND id IN (SELECT chunk_id FROM dataset_version_chunks
                  WHERE version_id = (SELECT active_version_id FROM lectures WHERE id = $1) AND chunk_index = 0)
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
    id: number; title: string; status: string; chunk_count: string; qa_count: string; created_at: Date; updated_at: Date;
    profile_is_active: boolean | null;
  }>(
    // chunk_count is every embedded piece; qa_count is Q&A pairs (a long answer
    // is stored as several pieces, each with the full Q&A — chunk_index 0 is
    // the first), the number lectureChunks lists.
    `SELECT l.id, l.title, l.status,
            COUNT(c.id) AS chunk_count,
            COUNT(c.id) FILTER (WHERE d.chunk_index = 0) AS qa_count,
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
    qaCount:    parseInt(r.qa_count),
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

// Content Gaps reads what actually happened to each question rather than
// guessing from word overlap.
//
// The old implementation tokenised student questions and lecture Q&As and
// called a question "answered" when any single word of it appeared in the
// lecture's vocabulary. That produced two wrong answers. A question whose
// every word was a stop word or shorter than four letters ("what is QA?")
// contributed nothing to the score but still counted as a miss, so a lecture
// could report 100% coverage while most of its questions went unanswered.
// And a question a student asked to test the tutor, about something the
// lecture never claimed to cover, was reported as a gap to fill.
//
// Both are already solved in the data. Every request is logged with its
// outcome, and a not-found outcome carries the reason the retrieval stage
// gave:
//
//   ALL_CANDIDATES_BELOW_RERANK_FLOOR — related material was found and the
//     reranker judged all of it too weak to answer with. The question belongs
//     to this lecture and the material is thin: a real gap.
//   NO_VECTOR_CANDIDATES — nothing in the lecture resembles the question at
//     all. Off topic. Uploading material for it would be a mistake.
//   EMPTY_LECTURE / NO_ACTIVE_VERSION — nothing is published yet. An upload
//     is owed, but that is a lecture-setup problem, not a content gap.
export const CONTENT_GAPS_WINDOW_DAYS = 90;
// The windows the report offers. Anything else is refused rather than passed
// into an interval, and the default is used.
export const CONTENT_GAPS_WINDOWS = [7, 30, 90, 180, 365];
// Bounded like the implementation it replaces: at most this many unanswered
// rows are read back for grouping, newest first.
export const CONTENT_GAPS_MAX_QUESTIONS = 20_000;
// And at most this many distinct questions are returned for one lecture.
export const CONTENT_GAPS_QUESTIONS_PER_LECTURE = 20;

const REASON_MISSING_MATERIAL = 'ALL_CANDIDATES_BELOW_RERANK_FLOOR';
const REASON_OFF_TOPIC        = 'NO_VECTOR_CANDIDATES';
const REASONS_NO_MATERIAL     = ['EMPTY_LECTURE', 'NO_ACTIVE_VERSION'];

export const getContentGaps = async (opts: { days?: number; courseId?: number } = {}) => {
  const windowDays = CONTENT_GAPS_WINDOWS.includes(Number(opts.days))
    ? Number(opts.days)
    : CONTENT_GAPS_WINDOW_DAYS;
  // Every lecture belongs to exactly one course (lectures.course_id is NOT
  // NULL since migration 022), so the course is a join, never a left join,
  // and a lecture can never be dropped by adding it.
  const courseId = Number.isInteger(Number(opts.courseId)) && Number(opts.courseId) > 0
    ? Number(opts.courseId)
    : null;
  logger.info(`[ANALYTICS] getContentGaps: reading recorded question outcomes (${windowDays}d${courseId ? `, course #${courseId}` : ''})`);

  // Per lecture, in the window: how many requests, and how each not-found
  // outcome was classified. Archived lectures are left out — they are no
  // longer served to students, so there is nothing to act on.
  const { rows: outcomeRows } = await query<{
    lecture_id: number; lecture_title: string;
    course_id: number; course_title: string;
    analysed: number; unanswered: number;
    missing_material: number; off_topic: number; no_material: number;
  }>(
    `SELECT r.lecture_id,
            l.title AS lecture_title,
            c.id    AS course_id,
            c.title AS course_title,
            COUNT(*)::int                                                      AS analysed,
            COUNT(*) FILTER (WHERE r.response_status = 'NOT_FOUND')::int       AS unanswered,
            COUNT(*) FILTER (WHERE r.not_found_reason = $2)::int               AS missing_material,
            COUNT(*) FILTER (WHERE r.not_found_reason = $3)::int               AS off_topic,
            COUNT(*) FILTER (WHERE r.not_found_reason = ANY($4::text[]))::int  AS no_material
       FROM rag_request_log r
       JOIN lectures l ON l.id = r.lecture_id
       JOIN courses  c ON c.id = l.course_id
      WHERE r.created_at >= NOW() - make_interval(days => $1)
        AND l.archived_at IS NULL
        AND ($5::int IS NULL OR l.course_id = $5)
      GROUP BY r.lecture_id, l.title, c.id, c.title`,
    [windowDays, REASON_MISSING_MATERIAL, REASON_OFF_TOPIC, REASONS_NO_MATERIAL, courseId]
  );
  if (outcomeRows.length === 0) return [];
  const lectureIds = outcomeRows.map(r => r.lecture_id);

  // How many questions were asked at all. The request log began with its
  // migration, so a lecture used before that has questions this analysis
  // cannot see; the difference is reported rather than hidden.
  const { rows: askedRows } = await query<{ lecture_id: number; asked: number }>(
    `SELECT lecture_id, COUNT(*)::int AS asked
       FROM student_questions
      WHERE lecture_id = ANY($1::int[])
        AND created_at >= NOW() - make_interval(days => $2)
      GROUP BY lecture_id`,
    [lectureIds, windowDays]
  );
  const askedMap = new Map(askedRows.map(r => [r.lecture_id, Number(r.asked)]));

  // The questions themselves, for the gaps worth acting on only. The text
  // lives in chat_history, which the request log joins by trace id. Repeats
  // are grouped so five students asking the same thing read as one job, with
  // a count — punctuation and case are normalised so they group together.
  const { rows: missedRows } = await query<{
    lecture_id: number; question: string; asked_count: number; last_asked: Date;
  }>(
    `SELECT r.lecture_id,
            MIN(ch.question)   AS question,
            COUNT(*)::int      AS asked_count,
            MAX(r.created_at)  AS last_asked
       FROM (
         SELECT trace_id, lecture_id, created_at
           FROM rag_request_log
          WHERE created_at >= NOW() - make_interval(days => $1)
            AND not_found_reason = $2
            AND lecture_id = ANY($3::int[])
          ORDER BY created_at DESC
          LIMIT $4
       ) r
       JOIN chat_history ch ON ch.trace_id = r.trace_id
      GROUP BY r.lecture_id, lower(regexp_replace(ch.question, '[^a-zA-Z0-9]+', ' ', 'g'))
      ORDER BY r.lecture_id, COUNT(*) DESC, MAX(r.created_at) DESC`,
    [windowDays, REASON_MISSING_MATERIAL, lectureIds, CONTENT_GAPS_MAX_QUESTIONS]
  );
  // One entry per DISTINCT question. The count of rows in rag_request_log is
  // how many times questions were asked, which is a different number: one
  // question asked twice is one thing to write, not two. The list is capped
  // for display, so the distinct total is counted before the cap applies.
  const missedMap = new Map<number, { question: string; askedCount: number; lastAskedAt: string }[]>();
  const distinctMap = new Map<number, number>();
  for (const m of missedRows) {
    distinctMap.set(m.lecture_id, (distinctMap.get(m.lecture_id) ?? 0) + 1);
    const list = missedMap.get(m.lecture_id) ?? [];
    if (list.length < CONTENT_GAPS_QUESTIONS_PER_LECTURE) {
      list.push({
        question:    m.question,
        askedCount:  Number(m.asked_count),
        lastAskedAt: new Date(m.last_asked).toISOString(),
      });
    }
    missedMap.set(m.lecture_id, list);
  }

  const results = outcomeRows.map(r => {
    const missingMaterial = Number(r.missing_material);
    const analysed = Number(r.analysed);
    const asked = askedMap.get(r.lecture_id) ?? analysed;
    return {
      lectureId:       r.lecture_id,
      lectureTitle:    r.lecture_title,
      // Carried on every row so the page can both filter by course and say
      // which course a lecture belongs to. With one course it is redundant;
      // with several, a flat list of lectures is unreadable without it.
      courseId:        r.course_id,
      courseTitle:     r.course_title,
      questionsAsked:  asked,
      // Below `asked` when the lecture was in use before request logging began.
      questionsAnalysed: analysed,
      unanswered:      Number(r.unanswered),
      // How many different questions need writing: the unit of work.
      questionsToAnswer: distinctMap.get(r.lecture_id) ?? 0,
      // How many times those questions were asked, across all students.
      missingMaterial,
      offTopic:        Number(r.off_topic),
      noMaterial:      Number(r.no_material),
      status:          missingMaterial > 0 ? 'NEEDS_MATERIAL' : 'CLEAR',
      missedQuestions: missedMap.get(r.lecture_id) ?? [],
      windowDays,
    };
  });

  // Most material owed first; that is the order the work should be done in.
  return results.sort((a, b) => b.questionsToAnswer - a.questionsToAnswer
    || b.missingMaterial - a.missingMaterial || b.unanswered - a.unanswered);
};

// Rankings below order by the numeric aggregate: the ::text aliases (kept for
// the row types) sorted alphabetically, so "9" ranked above "10".
export const getMyStats = async (studentId: string) => {
  // $1 is always the student id, $2 always the reporting timezone.
  const p = [studentId, env.REPORTING_TIMEZONE];
  const day = localDay('created_at', '$2::text');          // day a question was asked
  const today = `(NOW() AT TIME ZONE $2::text)::date`;     // today, in that same zone

  const [
    totalQs, totalSessions, lecturesEngaged, totalAvailableLectures,
    lastActiveRes, memberSinceRes, weekQs, lastWeekQs, topicRes,
    streakRes, dailyRes, lectureBreakdownRes, peakHourRes, todayRes,
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
    // The 7 calendar days ending today, in the reporting timezone — exactly the
    // seven bars the chart draws, so the figure and the chart can never
    // disagree. A rolling "NOW() - 7 days" would have covered part of an
    // eighth day and counted questions the chart does not show.
    query<{ count: string }>(
      `SELECT COUNT(*) FROM student_questions
        WHERE student_id = $1 AND ${day} > ${today} - 7`, p
    ),
    // The 7 calendar days immediately before those.
    query<{ count: string }>(
      `SELECT COUNT(*) FROM student_questions
        WHERE student_id = $1
          AND ${day} > ${today} - 14
          AND ${day} <= ${today} - 7`, p
    ),
    query<{ title: string; cnt: string }>(
      `SELECT l.title, COUNT(sq.id)::text AS cnt
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       GROUP BY l.title ORDER BY COUNT(sq.id) DESC LIMIT 1`, [studentId]
    ),
    query<{ day: string }>(
      `SELECT DISTINCT ${day}::text AS day
       FROM student_questions WHERE student_id = $1
       ORDER BY day DESC`, p
    ),
    query<{ day: string; count: string }>(
      `SELECT ${day}::text AS day, COUNT(*)::text AS count
       FROM student_questions
       WHERE student_id = $1 AND ${day} > ${today} - 7
       GROUP BY 1 ORDER BY 1 ASC`, p
    ),
    // No LIMIT. It used to be LIMIT 6, which silently dropped a student's
    // seventh and later lectures from the breakdown with nothing on screen to
    // say anything was missing.
    query<{ lecture_id: number; title: string; cnt: string }>(
      `SELECT l.id AS lecture_id, l.title, COUNT(sq.id)::text AS cnt
       FROM student_questions sq
       JOIN lectures l ON l.id = sq.lecture_id
       WHERE sq.student_id = $1
       GROUP BY l.id, l.title
       ORDER BY COUNT(sq.id) DESC, l.id ASC`, [studentId]
    ),
    query<{ hour: string; count: string }>(
      `SELECT EXTRACT(HOUR FROM (created_at)::timestamptz AT TIME ZONE $2::text)::text AS hour,
              COUNT(*)::text AS count
       FROM student_questions WHERE student_id = $1
       GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`, p
    ),
    // Today's date in the reporting timezone, read from the database so the
    // seven-day window is built from the same clock the grouping used. Taking
    // it from the Node process instead would drift whenever the server runs in
    // a different timezone from the one being reported on.
    query<{ today: string }>(
      `SELECT (NOW() AT TIME ZONE $1::text)::date::text AS today`, [env.REPORTING_TIMEZONE]
    ),
  ]);

  // Every day below is a "YYYY-MM-DD" string already expressed in the
  // reporting timezone, so day maths is done by shifting the date string and
  // never by subtracting milliseconds from the current instant: the old
  // version did the latter, which produced UTC days and put anything asked
  // between midnight and 05:00 Pakistan time on the wrong day.
  const todayStr = todayRes.rows[0]?.today ?? new Date().toISOString().slice(0, 10);
  const shiftDay = (isoDate: string, days: number) => {
    // Noon UTC, so adding whole days can never cross a boundary by accident.
    const d = new Date(`${isoDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  };
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  // Streak = consecutive days up to and including today on which something was
  // asked. streakRes is already ordered newest first.
  const dayStrings = streakRes.rows.map(r => String(r.day).slice(0, 10));
  let streak = 0;
  for (let i = 0; i < dayStrings.length; i++) {
    if (dayStrings[i] === dayKey(shiftDay(todayStr, -i))) streak++;
    else break;
  }

  const dailyMap = new Map(dailyRes.rows.map(r => [String(r.day).slice(0, 10), parseInt(r.count, 10)]));
  const weeklyActivity = Array.from({ length: 7 }, (_, i) => {
    const d = shiftDay(todayStr, -(6 - i));
    const dateStr = dayKey(d);
    return {
      // timeZone: 'UTC' is required. Without it the weekday is read off the
      // server's own timezone while the date was built at noon UTC, so a
      // server west of UTC would label every bar with the previous weekday.
      day:   d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
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

/**
 * One page of the signed-in student's own questions, newest first.
 *
 * getMyStats returns counts only, so the activity page could say how many
 * questions had been asked but never show one. This returns the question text
 * itself with the lecture it belongs to, which is what a student revising is
 * actually looking for.
 *
 * Scoped by student_id on every statement, so one student can never read
 * another's questions. The answer text is deliberately not selected: answers
 * run to several paragraphs and the list only needs the question.
 */
export const getMyRecentQuestions = async (
  studentId: string,
  pageIn: { limit?: number | null; offset?: number | null }
) => {
  const limit  = clampInt(pageIn.limit, 10, 1, 50);
  const offset = clampInt(pageIn.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const from = `FROM student_questions sq
     JOIN lectures l ON l.id = sq.lecture_id
     WHERE sq.student_id = $1`;

  const [{ rows }, { rows: cnt }] = await Promise.all([
    query<{ id: number; lecture_id: number; title: string; question: string; created_at: Date }>(
      `SELECT sq.id, sq.lecture_id, l.title, sq.question, sq.created_at
       ${from}
       ORDER BY sq.created_at DESC, sq.id DESC
       LIMIT $2 OFFSET $3`,
      [studentId, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n ${from}`, [studentId]),
  ]);

  const total = Number(cnt[0]?.n ?? 0);
  logger.info(`[ANALYTICS] myRecentQuestions: ${rows.length} of ${total} (offset ${offset})`);

  return {
    items: rows.map(r => ({
      id:           r.id,
      question:     r.question,
      lectureId:    r.lecture_id,
      lectureTitle: r.title,
      createdAt:    new Date(r.created_at).toISOString(),
    })),
    total,
    hasMore: offset + rows.length < total,
  };
};
