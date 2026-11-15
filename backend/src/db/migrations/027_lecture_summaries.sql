-- Lecture summaries, kept.
--
-- A summary was generated from scratch on every request: the same lecture,
-- the same material, the same answer, and a two-minute wait each time. It is
-- a pure function of one dataset version's chunks, so it is computed once and
-- read thereafter.
--
-- The key is (lecture, version), not the lecture alone. Uploading new material
-- creates a new version, so the old summary simply stops being looked up —
-- there is no cache to remember to clear, and a stale summary cannot be served
-- for material that has changed.

CREATE TABLE IF NOT EXISTS lecture_summaries (
  lecture_id  INT         NOT NULL REFERENCES lectures(id)         ON DELETE CASCADE,
  version_id  INT         NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  summary     TEXT        NOT NULL,
  -- How the summary was built, kept for the admin pages: a summary written
  -- from every batch is whole, and only whole summaries are stored.
  batch_count INT         NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lecture_id, version_id)
);

-- Deleting a version or a lecture takes its summaries with it (ON DELETE
-- CASCADE above); nothing else references this table.
