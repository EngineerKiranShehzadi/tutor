-- Fix cleanup regression introduced by migration 042.
-- The parent FK must cascade with version memberships, just like the
-- existing dataset_chunk_families(version_id,chunk_id) membership FK.
-- Chat history references lecture_qna_chunks, not these family rows.
ALTER TABLE dataset_chunk_families
  DROP CONSTRAINT IF EXISTS dataset_family_parent_same_version;

ALTER TABLE dataset_chunk_families
  ADD CONSTRAINT dataset_family_parent_same_version
  FOREIGN KEY (version_id,parent_chunk_id)
  REFERENCES dataset_version_chunks(version_id,chunk_id)
  ON DELETE CASCADE;
