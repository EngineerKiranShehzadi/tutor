import pool, { query } from '../config/database';
import { logger } from '../utils/logger';

/**
 * One-off backfill: a "Tutor ready" notification for every lecture that is
 * already READY, for every student.
 *
 * Why this is needed: the notifications table was added after these lectures
 * were prepared, so no row was ever written for them and the bell opens empty
 * until the next lecture is added.
 *
 * Two decisions that keep it honest:
 *
 *   created_at = the lecture's own updated_at, not now. The tutor became ready
 *   when it became ready; dating these "just now" would be false.
 *
 *   read_at = now, so every backfilled row is already read. The notification
 *   itself is true — the lecture is ready — but the student was never told at
 *   the time, and showing it as unread would claim they were. The unread badge
 *   stays reserved for events that really are new.
 *
 * Safe to run more than once: the unique index on
 * (user_id, lecture_id, type) makes a second run insert nothing.
 *
 * Run with:
 *   npx ts-node --transpile-only src/scripts/backfill-notifications.ts
 *
 * To undo, in the Neon SQL editor:
 *   DELETE FROM notifications WHERE type = 'TUTOR_READY' AND read_at IS NOT NULL;
 */

const run = async () => {
  const { rows: before } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM notifications`
  );
  const { rows: students } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM users WHERE role = 'STUDENT'`
  );
  const { rows: ready } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM lectures WHERE status = 'READY'`
  );

  console.log(`Students:          ${students[0]?.n ?? 0}`);
  console.log(`Ready lectures:    ${ready[0]?.n ?? 0}`);
  console.log(`Notifications now: ${before[0]?.n ?? 0}`);
  console.log('');

  if (Number(students[0]?.n ?? 0) === 0 || Number(ready[0]?.n ?? 0) === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  const { rowCount } = await query(
    `INSERT INTO notifications (user_id, type, title, body, lecture_id, created_at, read_at)
     SELECT u.id,
            'TUTOR_READY',
            'Tutor ready',
            l.title,
            l.id,
            COALESCE(l.updated_at, l.created_at, NOW()),
            NOW()
       FROM users u
       CROSS JOIN lectures l
      WHERE u.role = 'STUDENT'
        AND l.status = 'READY'
     ON CONFLICT DO NOTHING`
  );

  const { rows: after } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM notifications`
  );

  console.log(`Inserted:          ${rowCount ?? 0}`);
  console.log(`Notifications now: ${after[0]?.n ?? 0}`);
  console.log('');
  console.log('All backfilled rows are marked read, so the unread badge stays at zero.');
  console.log('✅ Backfill complete.');
};

run()
  .then(() => pool.end())
  .catch(err => {
    logger.error('[BACKFILL] failed', err);
    console.error('❌ Backfill failed:', (err as Error).message);
    process.exit(1);
  });
