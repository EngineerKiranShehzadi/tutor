-- Read-only verification AFTER migrations 006 + 007. Every row must say ok = true.
SELECT 'every READY lecture has an ACTIVE version' AS check_name,
       NOT EXISTS (SELECT 1 FROM lectures l WHERE l.status = 'READY' AND l.active_version_id IS NULL) AS ok;
SELECT 'active version member count = lecture chunk count (all lectures)' AS check_name,
       NOT EXISTS (SELECT 1 FROM lectures l WHERE l.active_version_id IS NOT NULL AND
         (SELECT count(*) FROM dataset_version_chunks d WHERE d.version_id = l.active_version_id) <>
         (SELECT count(*) FROM lecture_qna_chunks c WHERE c.lecture_id = l.id)) AS ok;
SELECT 'no chunk without qa_id / content_hash / model version (embedded chunks)' AS check_name,
       NOT EXISTS (SELECT 1 FROM lecture_qna_chunks WHERE qa_id IS NULL OR content_hash IS NULL OR (local_embedding IS NOT NULL AND embedding_model_version IS NULL)) AS ok;
SELECT 'no duplicate (version, qa_id, chunk_index)' AS check_name,
       NOT EXISTS (SELECT 1 FROM dataset_version_chunks GROUP BY version_id, qa_id, chunk_index HAVING count(*) > 1) AS ok;
SELECT 'exactly one ACTIVE version per lecture with a dataset' AS check_name,
       NOT EXISTS (SELECT 1 FROM dataset_versions WHERE status = 'ACTIVE' GROUP BY lecture_id HAVING count(*) > 1) AS ok;
SELECT 'answer memory: every row valid at migration time is bound to its lecture''s version' AS check_name,
       (SELECT count(*) FROM rag_answer_memory WHERE dataset_version_id IS NOT NULL) =
       (SELECT count(*) FROM rag_answer_memory m JOIN lectures l ON l.id = m.lecture_id
         WHERE m.lecture_content_hash = (SELECT md5(COALESCE(string_agg(c.id::text || ':' || md5(c.chunk_text), '|' ORDER BY c.id), '')) FROM lecture_qna_chunks c WHERE c.lecture_id = m.lecture_id)) AS ok;
SELECT 'new unique key + indexes exist on rag_answer_memory' AS check_name,
       (SELECT count(*) FROM pg_indexes WHERE tablename = 'rag_answer_memory' AND indexname IN ('uniq_rag_memory_version_key','idx_rag_memory_exact_lookup','idx_rag_memory_semantic_scope')) = 3 AS ok;
