-- Archiving for lectures.
--
-- Deleting a lecture cascades into eight tables: its dataset chunks, every
-- dataset version, its agent profile, its chat sessions and messages, every
-- student question recorded against it, its notifications and its answer
-- memory. That is the right behaviour for a lecture created by mistake and the
-- wrong one for a lecture that has been taught.
--
-- Archiving withdraws the lecture from students and leaves all of it in place,
-- and it can be undone. Idempotent, like every other migration here.

ALTER TABLE lectures ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

-- Listing active lectures, often for one course, is the common read.
CREATE INDEX IF NOT EXISTS idx_lectures_active
  ON lectures (course_id) WHERE archived_at IS NULL;
