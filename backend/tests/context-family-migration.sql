-- Run against a disposable PostgreSQL database after migration 041.
-- Check that the trigger exists and every dataset membership has exactly one
-- version-scoped family record, with stable QA identity and piece numbering.
DO $$
DECLARE missing_count BIGINT; inconsistent_count BIGINT; trigger_count INT;
BEGIN
 SELECT count(*) INTO trigger_count
 FROM pg_trigger
 WHERE tgrelid='dataset_version_chunks'::regclass
   AND tgname='register_dataset_chunk_family_trigger'
   AND NOT tgisinternal;
 IF trigger_count<>1 THEN
   RAISE EXCEPTION 'Expected one context-family membership trigger, got %',trigger_count;
 END IF;

 SELECT count(*) INTO missing_count
 FROM dataset_version_chunks d
 LEFT JOIN dataset_chunk_families f
   ON f.version_id=d.version_id AND f.chunk_id=d.chunk_id
 WHERE f.chunk_id IS NULL;
 IF missing_count<>0 THEN
   RAISE EXCEPTION '% dataset memberships lack family metadata',missing_count;
 END IF;

 SELECT count(*) INTO inconsistent_count
 FROM dataset_version_chunks d
 JOIN dataset_chunk_families f
   ON f.version_id=d.version_id AND f.chunk_id=d.chunk_id
 WHERE f.context_family_id IS DISTINCT FROM md5(d.qa_id)
    OR f.source_unit_id IS DISTINCT FROM md5(d.qa_id)
    OR f.part_index IS DISTINCT FROM d.chunk_index;
 IF inconsistent_count<>0 THEN
   RAISE EXCEPTION '% dataset family memberships disagree with immutable QA metadata',inconsistent_count;
 END IF;
END $$;
