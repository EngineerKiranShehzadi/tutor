-- Batch 2 (A2, A5). Idempotent.
--
-- dataset_versions.outage_since: when the current run of "embedding service
-- down / rate-limiting, no progress" began for an in-flight build. The
-- pipeline fails the build once it exceeds DATASET_OUTAGE_MAX_MINUTES, so an
-- outage or a quota problem can no longer hold the lecture's update slot (and
-- rollback) forever. NULL whenever the build is not waiting on an outage.
ALTER TABLE dataset_versions ADD COLUMN IF NOT EXISTS outage_since TIMESTAMPTZ;

-- Per-student daily question budget: counts a student's student_questions rows
-- of the last 24 hours on every question, so it needs this index.
CREATE INDEX IF NOT EXISTS idx_student_questions_student_created
  ON student_questions (student_id, created_at);
