-- A summary belongs to exactly one immutable dataset version, so keep it on
-- that version instead of maintaining a separate one-to-one table.
ALTER TABLE dataset_versions
  ADD COLUMN IF NOT EXISTS lecture_summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_batch_count INT,
  ADD COLUMN IF NOT EXISTS summary_provider TEXT,
  ADD COLUMN IF NOT EXISTS summary_model TEXT,
  ADD COLUMN IF NOT EXISTS summary_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- Preserve summaries created by the earlier migration 027. Their generator
-- fingerprint is unknown, so mark it legacy; startup warm-up rebuilds them.
-- On a fresh database migration 027 is a no-op and this conditional does
-- nothing, so no separate summary table is created at any point.
DO $$
BEGIN
  IF to_regclass('lecture_summaries') IS NOT NULL THEN
    EXECUTE $copy$
      UPDATE dataset_versions v
         SET lecture_summary = s.summary,
             summary_batch_count = s.batch_count,
             summary_provider = 'legacy',
             summary_model = 'legacy',
             summary_prompt_version = 'legacy',
             summary_generated_at = s.created_at
        FROM lecture_summaries s
       WHERE v.id = s.version_id
         AND v.lecture_id = s.lecture_id
    $copy$;
    EXECUTE 'DROP TABLE lecture_summaries';
  END IF;
END
$$;
