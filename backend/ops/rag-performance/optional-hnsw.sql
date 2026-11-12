-- OPTIONAL operator action on rag-hnsw-test first, NOT an automatic migration.
-- Normal Run; no Explain button. Existing suitable HNSW index is reused.
-- Normal CREATE INDEX blocks writes while building: use a maintenance window
-- on a busy DB. No vectors, dimensions, chunk IDs or membership are rewritten.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';
DO $$
DECLARE existing_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lecture_qna_chunks'::regclass
      AND attname = 'local_embedding' AND NOT attisdropped
      AND format_type(atttypid, atttypmod) = 'vector(1024)') THEN
    RAISE EXCEPTION 'Expected local_embedding vector(1024); no schema conversion performed';
  END IF;
  SELECT ci.relname INTO existing_name
  FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_am am ON am.oid = ci.relam
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
  JOIN pg_opclass op ON op.oid = i.indclass[0]
  WHERE i.indrelid = 'public.lecture_qna_chunks'::regclass AND am.amname = 'hnsw'
    AND a.attname = 'local_embedding' AND op.opcname = 'vector_cosine_ops'
    AND i.indisvalid AND i.indisready AND i.indnatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL
  LIMIT 1;
  IF existing_name IS NOT NULL THEN
    RAISE NOTICE 'Reusing existing index: %', existing_name;
  ELSE
    IF to_regclass('public.idx_chunks_embedding_hnsw') IS NOT NULL THEN
      RAISE EXCEPTION 'Index name occupied by a different/invalid index; inspect manually';
    END IF;
    CREATE INDEX idx_chunks_embedding_hnsw ON public.lecture_qna_chunks
      USING hnsw (local_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  END IF;
END $$;
COMMIT;
-- Creating an index does not prove it is chosen or faster. Check EXPLAIN/recall.
-- If any statement fails, ROLLBACK the failed transaction in the same session.
