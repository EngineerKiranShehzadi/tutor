-- Read-only: normal Run on rag-hnsw-test; no credentials in these results.
SELECT current_setting('shared_buffers') AS postgres_shared_buffers,
       (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector_version,
       pg_size_pretty(pg_table_size('public.lecture_qna_chunks')) AS chunks_including_toast,
       pg_size_pretty(pg_indexes_size('public.lecture_qna_chunks')) AS all_chunk_indexes,
       EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_prewarm') AS prewarm_available,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_prewarm') AS prewarm_installed;
SELECT ci.relname AS index_name, am.amname AS method, i.indisvalid, i.indisready,
       pg_size_pretty(pg_relation_size(ci.oid)) AS index_size, pg_get_indexdef(ci.oid) AS definition
FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_am am ON am.oid = ci.relam
WHERE i.indrelid = 'public.lecture_qna_chunks'::regclass ORDER BY ci.relname;
SELECT COUNT(*) AS all_chunks, COUNT(local_embedding) AS stored_vectors,
       MIN(vector_dims(local_embedding)) AS min_dimensions, MAX(vector_dims(local_embedding)) AS max_dimensions,
       pg_size_pretty(SUM(pg_column_size(local_embedding))::bigint) AS vector_values_size
FROM public.lecture_qna_chunks;
