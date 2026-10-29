-- Migration 007: bind rag_answer_memory to the active dataset version
-- Run after 006: psql $DATABASE_URL -f src/db/migrations/007_answer_memory_dataset_version.sql
--
-- A cached answer is only valid for the dataset version it was generated
-- from. Previously that was approximated by lecture_content_hash, an md5 over
-- every chunk of the lecture recomputed on each lookup. The cache key now
-- carries dataset_version_id instead: publishing (or rolling back to) another
-- version changes the id the lookup uses, so a cached answer from a different
-- version can never be returned — and rolling back makes the older version's
-- cache valid again.
--
-- No row is deleted. Existing rows whose lecture_content_hash still equals the
-- lecture's current content (they were generated from exactly what backfilled
-- version 1 contains) are attached to that version; every other row keeps
-- dataset_version_id NULL and is simply never matched.

ALTER TABLE rag_answer_memory
  ADD COLUMN IF NOT EXISTS dataset_version_id INT REFERENCES dataset_versions(id) ON DELETE CASCADE;

-- Old key / indexes were built on lecture_content_hash.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'rag_answer_memory'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%lecture_content_hash%'
  LOOP
    EXECUTE format('ALTER TABLE rag_answer_memory DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
DROP INDEX IF EXISTS idx_rag_memory_exact_lookup;
DROP INDEX IF EXISTS idx_rag_memory_semantic_scope;

ALTER TABLE rag_answer_memory ALTER COLUMN lecture_content_hash DROP NOT NULL;

UPDATE rag_answer_memory m
SET dataset_version_id = l.active_version_id
FROM lectures l
WHERE m.dataset_version_id IS NULL
  AND l.id = m.lecture_id
  AND l.active_version_id IS NOT NULL
  AND m.lecture_content_hash = (
    SELECT md5(COALESCE(string_agg(c.id::text || ':' || md5(c.chunk_text), '|' ORDER BY c.id), ''))
    FROM lecture_qna_chunks c
    WHERE c.lecture_id = m.lecture_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_rag_memory_version_key
  ON rag_answer_memory (student_id, lecture_id, normalized_query, dataset_version_id, embedding_model_version, answer_prompt_version);

CREATE INDEX IF NOT EXISTS idx_rag_memory_exact_lookup
  ON rag_answer_memory (student_id, lecture_id, normalized_query, dataset_version_id, embedding_model_version, answer_prompt_version)
  WHERE cache_eligible = TRUE;

CREATE INDEX IF NOT EXISTS idx_rag_memory_semantic_scope
  ON rag_answer_memory (student_id, lecture_id, dataset_version_id, embedding_model_version, answer_prompt_version)
  WHERE cache_eligible = TRUE;
