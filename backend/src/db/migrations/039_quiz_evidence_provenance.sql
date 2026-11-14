-- Store the exact quote verified against lecture source, with its immutable
-- source dataset version. Additive only: historical quiz rows remain intact.
ALTER TABLE practice_questions ADD COLUMN IF NOT EXISTS evidence_quote TEXT;
ALTER TABLE practice_questions ADD COLUMN IF NOT EXISTS source_version_id INT REFERENCES dataset_versions(id) ON DELETE SET NULL;
ALTER TABLE practice_questions ADD CONSTRAINT practice_evidence_quote_length
  CHECK (evidence_quote IS NULL OR char_length(evidence_quote) BETWEEN 15 AND 320);
