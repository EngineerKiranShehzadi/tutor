-- 020_notifications.sql
--
-- A real notification record, one row per student per event.
--
-- The bell previously derived its contents from lecture timestamps. That could
-- not store whether a student had read something (it lived in the browser), it
-- could not survive a title edit without re-announcing the lecture, and there
-- was no record of what had ever been sent. This table replaces all of that.
--
-- Rows are written when an event happens (a lecture is added, a tutor becomes
-- ready) and fanned out to every student. read_at is NULL until the student
-- opens the bell.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'LECTURE_ADDED' | 'TUTOR_READY'. Kept as text rather than an enum so a new
  -- kind does not need a migration; unknown kinds fall back to a neutral icon.
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  -- The lecture the notification points at. ON DELETE CASCADE: if a lecture is
  -- removed, notifications about it go with it rather than linking nowhere.
  lecture_id  INTEGER     REFERENCES lectures(id) ON DELETE CASCADE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The bell's own query: this user's rows, newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- The unread count, which runs on every page load. Partial index: only unread
-- rows are indexed, so it stays small however much history builds up.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;

-- One notification of a given kind per student per lecture. Without this, a
-- re-embedding or a retried status update would announce the same lecture
-- twice, which is the exact fault the derived version had.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_lecture_type
  ON notifications (user_id, lecture_id, type)
  WHERE lecture_id IS NOT NULL;
