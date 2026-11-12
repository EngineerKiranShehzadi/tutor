-- Archiving for courses.
--
-- A course that is no longer taught cannot simply be deleted: its lectures,
-- their datasets, and every question a student ever asked against it hang off
-- its id. Archiving hides the course from students and from the pickers that
-- create new lectures, while leaving all of that history intact, and it can be
-- undone. Hard deletion stays available only for a course that never had a
-- lecture, which is the case where nothing is lost.
--
-- Idempotent, in line with every other migration in this folder.

ALTER TABLE courses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

-- Listing active courses is the common read, so the partial index covers it.
CREATE INDEX IF NOT EXISTS idx_courses_active
  ON courses (id) WHERE archived_at IS NULL;
