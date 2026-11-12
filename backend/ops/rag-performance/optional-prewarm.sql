-- OPTIONAL, one-off bounded whole-index prewarm. NOT for every page visit.
-- Requires pg_prewarm ALREADY installed; inspect.sql checks availability.
-- Run on rag-hnsw-test first. This does NOT pin pages or load all lecture text.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
DO $$
DECLARE ext_schema text; idx record; warmed bigint; cap bigint;
BEGIN
  SELECT n.nspname INTO ext_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_prewarm';
  IF ext_schema IS NULL THEN
    RAISE EXCEPTION 'pg_prewarm is not installed; verify availability and operator permissions first';
  END IF;
  SELECT ci.oid, ci.relname INTO idx
  FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_am am ON am.oid = ci.relam
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
  JOIN pg_opclass op ON op.oid = i.indclass[0]
  WHERE i.indrelid = 'public.lecture_qna_chunks'::regclass AND am.amname = 'hnsw'
    AND a.attname = 'local_embedding' AND op.opcname = 'vector_cosine_ops'
    AND i.indisvalid AND i.indisready AND i.indnatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL
  ORDER BY ci.oid LIMIT 1;
  IF idx.oid IS NULL THEN RAISE EXCEPTION 'No valid full-column cosine HNSW index found'; END IF;
  cap := LEAST(64::bigint * 1024 * 1024, pg_size_bytes(current_setting('shared_buffers')) / 2);
  IF pg_relation_size(idx.oid) > cap THEN
    RAISE EXCEPTION 'Index exceeds bounded prewarm budget (% bytes); inspect capacity first', cap;
  END IF;
  EXECUTE format('SELECT %I.pg_prewarm($1::regclass, ''buffer'')', ext_schema) INTO warmed USING idx.oid;
  RAISE NOTICE 'Index %: % blocks prewarmed. Residency is not guaranteed; text/TOAST not prewarmed.', idx.relname, warmed;
END $$;
ROLLBACK;
-- ROLLBACK restores settings; it does NOT undo the cache reads.
