-- Version-scoped family metadata. Existing embeddings and chunk rows are untouched.
-- Family identity uses the immutable membership qa_id, never display labels.
CREATE TABLE IF NOT EXISTS dataset_chunk_families (
 version_id INT NOT NULL,
 chunk_id INT NOT NULL,
 source_unit_id TEXT NOT NULL,
 context_family_id TEXT NOT NULL,
 part_index INT NOT NULL CHECK (part_index >= 0),
 source_locator TEXT,
 PRIMARY KEY (version_id,chunk_id),
 FOREIGN KEY (version_id,chunk_id)
   REFERENCES dataset_version_chunks(version_id,chunk_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunk_family_lookup
 ON dataset_chunk_families(version_id,context_family_id,part_index);

CREATE OR REPLACE FUNCTION register_dataset_chunk_family()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO dataset_chunk_families
   (version_id,chunk_id,source_unit_id,context_family_id,part_index,source_locator)
 SELECT NEW.version_id,NEW.chunk_id,
   md5(NEW.qa_id),md5(NEW.qa_id),NEW.chunk_index,c.start_time
 FROM lecture_qna_chunks c WHERE c.id=NEW.chunk_id
 ON CONFLICT (version_id,chunk_id) DO NOTHING;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS register_dataset_chunk_family_trigger ON dataset_version_chunks;
CREATE TRIGGER register_dataset_chunk_family_trigger
 AFTER INSERT ON dataset_version_chunks FOR EACH ROW
 EXECUTE FUNCTION register_dataset_chunk_family();

-- Backfill the membership metadata; reruns are safe.
INSERT INTO dataset_chunk_families
 (version_id,chunk_id,source_unit_id,context_family_id,part_index,source_locator)
SELECT d.version_id,d.chunk_id,md5(d.qa_id),md5(d.qa_id),
 d.chunk_index,c.start_time
FROM dataset_version_chunks d
JOIN lecture_qna_chunks c ON c.id=d.chunk_id
ON CONFLICT (version_id,chunk_id) DO NOTHING;
