-- Additive quiz evidence provenance. Safe to rerun.
ALTER TABLE practice_questions ADD COLUMN IF NOT EXISTS evidence_quote TEXT;
ALTER TABLE practice_questions ADD COLUMN IF NOT EXISTS source_version_id INT REFERENCES dataset_versions(id) ON DELETE SET NULL;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='practice_evidence_quote_length'
    AND conrelid='practice_questions'::regclass) THEN
  ALTER TABLE practice_questions ADD CONSTRAINT practice_evidence_quote_length
   CHECK (evidence_quote IS NULL OR char_length(evidence_quote) BETWEEN 15 AND 320);
 END IF;
END $$;
