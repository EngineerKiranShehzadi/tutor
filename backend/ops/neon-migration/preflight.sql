-- Read-only pre-flight. Everything marked MUST must be as stated before migrating.
SELECT 'server_version' AS item, current_setting('server_version') AS value, 'info' AS expect;
SELECT 'pgvector' AS item, coalesce((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'MISSING') AS value, 'MUST be present' AS expect;
SELECT 'lectures not READY / NO_DATASET (uploads in flight?)' AS item, string_agg(id || ':' || status, ', ') AS value, 'MUST be empty — wait for them to finish' AS expect
  FROM lectures WHERE status IN ('DATASET_UPLOADED', 'PROCESSING', 'EMBEDDING');
SELECT 'READY lectures with un-embedded chunks (would be skipped by backfill)' AS item, count(*)::text AS value, 'MUST be 0' AS expect
  FROM lectures l WHERE l.status = 'READY' AND EXISTS (SELECT 1 FROM lecture_qna_chunks c WHERE c.lecture_id = l.id AND c.local_embedding IS NULL);
SELECT 'chat_history sources pointing at missing chunks' AS item, count(*)::text AS value, 'info (pre-existing)' AS expect
  FROM chat_history h WHERE EXISTS (SELECT 1 FROM unnest(h.source_chunk_ids) s WHERE NOT EXISTS (SELECT 1 FROM lecture_qna_chunks c WHERE c.id = s));
SELECT 'rag_answer_memory.lecture_content_hash NULLs' AS item, count(*)::text AS value, 'MUST be 0 (legacy column still populated)' AS expect
  FROM rag_answer_memory WHERE lecture_content_hash IS NULL;
SELECT 'tables already migrated?' AS item, coalesce((SELECT 'dataset_versions EXISTS' FROM information_schema.tables WHERE table_name = 'dataset_versions'), 'no') AS value, 'expect: no (first run)' AS expect;
