-- Additive explicit family metadata for immutable version memberships.
-- New version inserts are automatically indexed, including MERGE carried rows.
CREATE TABLE IF NOT EXISTS dataset_chunk_families (
 version_id INT NOT NULL,
 chunk_id INT NOT NULL,
 source_unit_id TEXT NOT NULL,
 context_family_id TEXT NOT NULL,
 part_index INT NOT NULL CHECK(part_index>=0),
 source_locator TEXT,
 PRIMARY KEY(version_id,chunk_id),
 FOREIGN KEY(version_id,chunk_id) REFERENCES dataset_version_chunks(version_id,chunk_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunk_family_lookup
 ON dataset_chunk_families(version_id,context_family_id,part_index);

CREATE OR REPLACE FUNCTION register_dataset_chunk_family()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 c RECORD;
 unit_key TEXT;
 family_key TEXT;
 label TEXT;
 part_no INT;
BEGIN
 SELECT question,start_time INTO c FROM lecture_qna_chunks WHERE id=NEW.chunk_id;
 unit_key:=coalesce(c.start_time,'unknown-source');
 label:=coalesce(c.question,'');
 IF label LIKE 'Source excerpt:%' AND label ~ '[|] (Part|Visual) [0-9]+$' THEN
   family_key:=regexp_replace(label,'[|] (Part|Visual) [0-9]+$','');
   part_no:=substring(label FROM '([0-9]+)$')::int-1;
 ELSE
   family_key:=regexp_replace(label,' \[Answer part [0-9]+\]$','');
   part_no:=NEW.chunk_index;
 END IF;
 INSERT INTO dataset_chunk_families(version_id,chunk_id,source_unit_id,context_family_id,part_index,source_locator)
 VALUES(NEW.version_id,NEW.chunk_id,md5(unit_key),md5(unit_key||'|'||family_key),greatest(part_no,0),c.start_time)
 ON CONFLICT(version_id,chunk_id) DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS register_dataset_chunk_family_trigger ON dataset_version_chunks;
CREATE TRIGGER register_dataset_chunk_family_trigger
AFTER INSERT ON dataset_version_chunks FOR EACH ROW
EXECUTE FUNCTION register_dataset_chunk_family();

-- Backfill membership metadata only. Existing chunks and embeddings stay unchanged.
INSERT INTO dataset_chunk_families(version_id,chunk_id,source_unit_id,context_family_id,part_index,source_locator)
SELECT d.version_id,d.chunk_id,md5(coalesce(c.start_time,'unknown-source')),
 md5(coalesce(c.start_time,'unknown-source')||'|'||
   CASE WHEN c.question LIKE 'Source excerpt:%' AND c.question ~ '[|] (Part|Visual) [0-9]+$'
     THEN regexp_replace(c.question,'[|] (Part|Visual) [0-9]+$','')
     ELSE regexp_replace(c.question,' \[Answer part [0-9]+\]$','') END),
 CASE WHEN c.question LIKE 'Source excerpt:%' AND c.question ~ '[|] (Part|Visual) [0-9]+$'
   THEN greatest(substring(c.question FROM '([0-9]+)$')::int-1,0)
   ELSE d.chunk_index END,c.start_time
FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id=d.chunk_id
ON CONFLICT(version_id,chunk_id) DO NOTHING;
