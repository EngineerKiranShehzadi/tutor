import { query } from '../config/database';
import { logger } from '../utils/logger';
import { clampInt } from '../utils/paging';

/**
 * Notifications — stored records, not derived ones.
 *
 * A row is written for every student when something happens that is worth
 * telling them about. Read state lives in the database, so it is the same on
 * every device the student signs in on.
 *
 * Fan-out is done in one INSERT ... SELECT rather than a loop, so adding a
 * lecture costs one statement no matter how many students are registered.
 */

export type NotificationType = 'LECTURE_ADDED' | 'TUTOR_READY';

const MAX_PAGE = 50;

/**
 * Write one notification for every student.
 *
 * ON CONFLICT DO NOTHING works with the unique index on
 * (user_id, lecture_id, type): a lecture that is re-embedded, or a status
 * update that runs twice, cannot announce itself twice. Students who register
 * later do not receive notifications for events that happened before they
 * joined, which is the behaviour you want — a new student should not open the
 * bell to a list of historic announcements.
 *
 * Never throws into the caller. A notification failing must not roll back the
 * lecture that was just created or the dataset that just finished embedding.
 */
export const notifyAllStudents = async (
  type: NotificationType,
  title: string,
  body: string,
  lectureId: number | null
): Promise<number> => {
  try {
    const { rowCount } = await query(
      `INSERT INTO notifications (user_id, type, title, body, lecture_id)
       SELECT u.id, $1, $2, $3, $4
         FROM users u
        WHERE u.role = 'STUDENT'
       ON CONFLICT DO NOTHING`,
      [type, title, body, lectureId]
    );
    const n = rowCount ?? 0;
    logger.info(`[NOTIFY] ${type} -> ${n} student(s) (lecture #${lectureId ?? 'none'})`);
    return n;
  } catch (err) {
    logger.error(`[NOTIFY] failed to write ${type} for lecture #${lectureId ?? 'none'}`, err);
    return 0;
  }
};

/** One page of this student's notifications, newest first. */
export const getMyNotifications = async (
  userId: string,
  page: { limit?: number | null; offset?: number | null }
) => {
  const limit  = clampInt(page.limit, 10, 1, MAX_PAGE);
  const offset = clampInt(page.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const [{ rows }, { rows: counts }] = await Promise.all([
    query<{
      id: number; type: string; title: string; body: string;
      lecture_id: number | null; read_at: Date | null; created_at: Date;
    }>(
      `SELECT id, type, title, body, lecture_id, read_at, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    query<{ total: string; unread: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL)::text AS unread
         FROM notifications WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const total  = Number(counts[0]?.total ?? 0);
  const unread = Number(counts[0]?.unread ?? 0);

  return {
    items: rows.map(r => ({
      id:        r.id,
      type:      r.type,
      title:     r.title,
      body:      r.body,
      lectureId: r.lecture_id,
      read:      r.read_at !== null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total,
    unread,
    hasMore: offset + rows.length < total,
  };
};

/**
 * Mark this student's notifications read.
 *
 * With no ids, marks all of them. Scoped by user_id on the statement itself, so
 * passing another student's notification id changes nothing.
 */
export const markNotificationsRead = async (
  userId: string,
  ids?: number[] | null
): Promise<number> => {
  const hasIds = Array.isArray(ids) && ids.length > 0;
  const { rowCount } = await query(
    hasIds
      ? `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::int[])`
      : `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL`,
    hasIds ? [userId, ids!.slice(0, 200)] : [userId]
  );
  const n = rowCount ?? 0;
  logger.info(`[NOTIFY] marked ${n} notification(s) read for user ${userId}`);
  return n;
};
