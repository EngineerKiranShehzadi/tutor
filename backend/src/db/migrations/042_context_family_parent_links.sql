-- Add explicit parent references to version-scoped context families without changing embeddings.
-- Migration 041 already populates family identity and source locators for old memberships.
ALTER TABLE dataset_chunk_families
  ADD COLUMN IF NOT EXISTS parent_chunk_id INT,
  ADD COLUMN IF NOT EXISTS part_count INT;

-- The parent must be a member of the SAME immutable dataset version.
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname='dataset_family_parent_same_version'
    AND conrelid='dataset_chunk_families'::regclass
 ) THEN
  ALTER TABLE dataset_chunk_families
    ADD CONSTRAINT dataset_family_parent_same_version
    FOREIGN KEY (version_id,parent_chunk_id)
    REFERENCES dataset_version_chunks(version_id,chunk_id);
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname='dataset_family_part_count_valid'
    AND conrelid='dataset_chunk_families'::regclass
 ) THEN
  ALTER TABLE dataset_chunk_families
    ADD CONSTRAINT dataset_family_part_count_valid
    CHECK (part_count IS NULL OR (part_count >= 1 AND part_index < part_count));
 END IF;
END $$;

-- Called only after all memberships for a new version are inserted, including MERGE carryovers.
-- This avoids ordering assumptions in the per-row registration trigger from migration 041.
CREATE OR REPLACE FUNCTION finalize_dataset_chunk_families(target_version INT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 WITH family_stats AS (
  SELECT version_id,context_family_id,
         COUNT(*)::int AS member_count,
         MIN(chunk_id) FILTER (WHERE part_index=0) AS root_chunk_id
  FROM dataset_chunk_families
  WHERE version_id=target_version
  GROUP BY version_id,context_family_id
 )
 UPDATE dataset_chunk_families f
 SET part_count=s.member_count,
     parent_chunk_id=CASE WHEN f.part_index=0 THEN NULL ELSE s.root_chunk_id END
 FROM family_stats s
 WHERE f.version_id=s.version_id AND f.context_family_id=s.context_family_id;
END $$;

-- Backfill existing immutable versions; no chunk contents or vectors are rewritten.
WITH family_stats AS (
 SELECT version_id,context_family_id,
        COUNT(*)::int AS member_count,
        MIN(chunk_id) FILTER (WHERE part_index=0) AS root_chunk_id
 FROM dataset_chunk_families
 GROUP BY version_id,context_family_id
)
UPDATE dataset_chunk_families f
SET part_count=s.member_count,
    parent_chunk_id=CASE WHEN f.part_index=0 THEN NULL ELSE s.root_chunk_id END
FROM family_stats s
WHERE f.version_id=s.version_id AND f.context_family_id=s.context_family_id;
